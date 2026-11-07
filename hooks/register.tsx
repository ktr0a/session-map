import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, McpToolResult, Register } from 'claude-code'

import type { Bridge, Labels, Nests, Row, Section, Snapshot, View } from '../types'
import { INDEX_HTML, SERVER_JS } from './web-assets.ts'

type Engine = EngineInterface

const PANE = 'session-map'
const TITLE = 'Bundles'
const SIDEBAR = 'ccd_sidebar'
const SESSIONS = 'ccd_session_mgmt'
const UNSORTED = 'sessions'
/** A section named "Parent · Branch" is drawn as a branch of "Parent". */
const SEP = ' · '
const REFRESH_MS = 15_000
const ACTION_POLL_MS = 1_000
const PORTS = [47821, 47822, 47823, 47824, 47825]

const EMPTY: Snapshot = { rows: [], sections: [], loadedAt: 0 }
const START: View = {
  toggled: [],
  selected: '',
  confirm: '',
  busy: '',
  note: '',
  creating: false,
  newParent: '',
}
const NO_NESTS: Nests = {}
const NO_BRIDGE: Bridge = { url: '', status: 'starting', detail: '' }
// Display names, kept in the mod's store under `labels`: a parent bundle's title
// (`parents`), and the branch name of a section named exactly like its parent (`children`).
const DEFAULT_LABELS: Labels = { parents: {}, children: {} }

const snapshot = atom({ plugin: 'session-map', key: 'snapshot' } as const, EMPTY, {
  shape: 'snapshot-2',
})
const view = atom({ plugin: 'session-map', key: 'view' } as const, START, { shape: 'view-3' })
const nests = atom({ plugin: 'session-map', key: 'nests' } as const, NO_NESTS, {
  shape: 'nests-1',
})
const bridgeState = atom({ plugin: 'session-map', key: 'bridge' } as const, NO_BRIDGE, {
  shape: 'bridge-1',
})

// Where the map's files live, and the token its page must send. Set once the bridge starts.
const bridge = { dir: '', token: '' }

// ---------- talking to the app ----------

/** Calls one of the app's own tools and parses its JSON answer. */
async function ccd(
  $: Engine,
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  let text = ''
  let result: McpToolResult | undefined
  try {
    result = await $.mcp.call(server, tool, args)
  } catch {
    result = undefined
  }
  if (result) {
    text = result.content.map(block => (block as { text?: string }).text ?? '').join('')
    if (result.isError) throw new Error(text || `${tool} failed`)
  } else {
    // Not reachable as an MCP server here: go through the engine's tool call.
    const ran = (await $.tool.call({ tool: `mcp__${server}__${tool}`, ...args } as never)) as {
      text?: string
      deny?: string
      isError?: boolean
      result?: unknown
    }
    if (ran.deny) throw new Error(ran.deny)
    text =
      ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))
    if (ran.isError) throw new Error(text || `${tool} failed`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

type RawSession = {
  sessionId: string
  title?: string
  group?: { id: string } | null
  pinned?: boolean
  isRunning?: boolean
  lastActivityAt?: string
  scheduledTaskId?: string
  startedBy?: string
  parentSessionId?: string
}
type RawSection = { id: string; kind: string; name: string; order: number; shown?: boolean }

function toRow(raw: RawSession, kinds: Record<string, string>, isSelf: boolean): Row {
  return {
    id: raw.sessionId,
    title: raw.title || 'Untitled session',
    group: raw.group?.id ?? null,
    pinned: raw.pinned === true,
    running: raw.isRunning === true,
    lastActivityAt: raw.lastActivityAt ?? '',
    routine: kinds[raw.sessionId] === 'routine' || Boolean(raw.scheduledTaskId),
    isSelf,
    startedBy: raw.startedBy ?? raw.parentSessionId ?? null,
  }
}

async function loadLabels($: Engine): Promise<Labels> {
  return (((await $.store.get('labels')) as Labels | undefined) ?? DEFAULT_LABELS) as Labels
}

async function refresh($: Engine): Promise<void> {
  try {
    const [sessionsRaw, sectionsRaw, selfRaw] = await Promise.all([
      ccd($, SESSIONS, 'list_sessions', { limit: 200 }),
      ccd($, SIDEBAR, 'list_sections'),
      ccd($, SESSIONS, 'get_session', { session_id: 'self' }).catch(() => undefined),
    ])
    const list = (Array.isArray(sessionsRaw) ? sessionsRaw : []) as RawSession[]
    const secs = (Array.isArray(sectionsRaw) ? sectionsRaw : []) as RawSection[]

    // Scheduled runs can't be filed; learn once which ungrouped rows are runs.
    const kinds = ((await $.store.get('kinds')) ?? {}) as Record<string, string>
    const unknown = list.filter(s => !s.group && !(s.sessionId in kinds)).slice(0, 60)
    if (unknown.length > 0) {
      await Promise.all(
        unknown.map(async s => {
          try {
            const detail = (await ccd($, SESSIONS, 'get_session', {
              session_id: s.sessionId,
            })) as RawSession
            kinds[s.sessionId] = detail?.scheduledTaskId ? 'routine' : 'session'
          } catch {
            // Left unknown: asked again on the next refresh.
          }
        }),
      )
      await $.store.set('kinds', kinds)
    }

    const rows = list.map(s => toRow(s, kinds, false))
    const self = selfRaw as RawSession | undefined
    if (self?.sessionId && !rows.some(r => r.id === self.sessionId)) {
      rows.push(toRow(self, kinds, true))
    }
    const sections = secs
      .filter(s => s.kind === 'manual' && s.shown !== false)
      .sort((a, b) => a.order - b.order)
      .map(s => ({ id: s.id, name: s.name, order: s.order }))

    await update($, snapshot, () => ({ rows, sections, loadedAt: Date.now() }))
  } catch (err) {
    const error = message(err)
    await update($, snapshot, s => ({ ...s, error, loadedAt: Date.now() }))
  }
  await writeMapData($)
}

/** Runs one change from the pane, then refreshes and says how it went. */
async function act($: Engine, label: string, work: () => Promise<unknown>): Promise<void> {
  await update($, view, v => ({ ...v, busy: label, note: '' }))
  let note: string
  try {
    await work()
    note = `${label}: done`
  } catch (err) {
    note = `${label} failed: ${message(err)}`
  }
  await refresh($)
  await update($, view, v => ({ ...v, busy: '', note, confirm: '' }))
}

async function saveNests($: Engine): Promise<void> {
  await $.store.set('nests', await read($, nests))
}

async function setNest($: Engine, child: string, parent: string): Promise<void> {
  await update($, nests, m => {
    const next = { ...m }
    if (parent) next[child] = parent
    else delete next[child]
    return next
  })
  await saveNests($)
}

/**
 * Opens a session in the app through its own link (claude://), handed to the
 * operating system: the pane's links only follow https.
 */
async function openSession($: Engine, id: string): Promise<boolean> {
  return openExternal($, `claude://claude.ai/epitaxy/${id}`)
}

async function openExternal($: Engine, url: string): Promise<boolean> {
  const tries: string[][] = [
    ['cmd', '/c', 'start', '', url],
    ['open', url],
    ['xdg-open', url],
  ]
  for (const argv of tries) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      if (ran.exitCode === 0) return true
    } catch {
      // Not this platform's opener: try the next.
    }
  }
  return false
}

// ---------- the map bridge ----------
// The interactive map is a page served on this computer (127.0.0.1 only).
// The mod writes the session data for it and carries out what it asks, since
// only the mod can reach the app's own tools.

function randomToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

async function startBridge($: Engine): Promise<void> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) {
    await update($, bridgeState, () => ({ url: '', status: 'unavailable', detail: 'No home folder found' }))
    return
  }
  const dir = `${home.replace(/\\/g, '/')}/.claude/session-map`
  await $.fs.write(`${dir}/index.html`, INDEX_HTML)
  await $.fs.write(`${dir}/server.mjs`, SERVER_JS)
  let token = ''
  try {
    token = String(await $.fs.read(`${dir}/token.txt`)).trim()
  } catch {
    token = ''
  }
  if (!/^[\w-]{16,}$/.test(token)) {
    token = randomToken()
    await $.fs.write(`${dir}/token.txt`, token)
  }
  bridge.dir = dir
  bridge.token = token
  await writeMapData($)
  await ensureServer($)
}

let isServing = false

/** Uses a map server that is already up (its heartbeat is fresh), or starts one. */
async function ensureServer($: Engine): Promise<void> {
  if (!bridge.dir || isServing) return
  try {
    const alive = JSON.parse(String(await $.fs.read(`${bridge.dir}/alive.json`))) as { port?: unknown; at?: unknown }
    if (typeof alive.port === 'number' && typeof alive.at === 'number' && Date.now() - alive.at < 15_000) {
      const url = `http://127.0.0.1:${alive.port}/?t=${bridge.token}`
      const b = await read($, bridgeState)
      if (b.url !== url || b.status !== 'live') {
        await update($, bridgeState, () => ({ url, status: 'live', detail: '' }))
      }
      return
    }
  } catch {
    // No heartbeat yet: start one below.
  }
  isServing = true
  void runServer($, 0).finally(() => {
    isServing = false
  })
}

/** Starts the map server on the first free port; its life is the module's. */
async function runServer($: Engine, index: number): Promise<void> {
  const port = PORTS[index]
  if (port === undefined) {
    await update($, bridgeState, () => ({
      url: '',
      status: 'unavailable',
      detail: 'Node.js did not start the map server (is node installed?)',
    }))
    return
  }
  let isUp = false
  try {
    const child = $.process.spawn({
      argv: ['node', `${bridge.dir}/server.mjs`, bridge.dir, String(port), bridge.token],
    })
    for await (const chunk of child) {
      if (!isUp && chunk.text.includes('server on')) {
        isUp = true
        await update($, bridgeState, () => ({
          url: `http://127.0.0.1:${port}/?t=${bridge.token}`,
          status: 'live',
          detail: '',
        }))
      }
    }
  } catch {
    // Could not start: try the next port below.
  }
  if (!isUp) {
    await runServer($, index + 1)
    return
  }
  await update($, bridgeState, b => ({ ...b, status: 'stopped', detail: 'The map server stopped' }))
}

async function writeMapData($: Engine): Promise<void> {
  if (!bridge.dir) return
  const snap = await read($, snapshot)
  const data = {
    ...snap,
    labels: await loadLabels($),
    nests: await read($, nests),
  }
  try {
    await $.fs.write(`${bridge.dir}/data.json`, JSON.stringify(data))
  } catch {
    // The map shows the last data it had.
  }
}

type MapAction = {
  id: string
  type: 'move' | 'pin' | 'archive' | 'nest' | 'open' | 'create' | 'refresh'
  sessionId?: unknown
  target?: unknown
  pinned?: unknown
  parent?: unknown
  name?: unknown
}

let isPolling = false
const handled = new Set<string>()

/** Picks up what the map asked for, does it, and leaves the answer for the page. */
async function pollActions($: Engine): Promise<void> {
  if (isPolling || !bridge.dir) return
  isPolling = true
  try {
    let entries: { name: string; kind: string }[] = []
    try {
      entries = await $.fs.list(`${bridge.dir}/actions`)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (handled.has(id)) continue
      handled.add(id)
      if (await $.fs.exists(`${bridge.dir}/results/${id}.json`)) continue
      let outcome: { ok: boolean; message: string }
      try {
        const action = JSON.parse(String(await $.fs.read(`${bridge.dir}/actions/${entry.name}`))) as MapAction
        outcome = { ok: true, message: await runAction($, action) }
      } catch (err) {
        outcome = { ok: false, message: message(err) }
      }
      await $.fs.write(`${bridge.dir}/results/${id}.json`, JSON.stringify(outcome))
    }
  } finally {
    isPolling = false
  }
}

async function runAction($: Engine, a: MapAction): Promise<string> {
  const snap = await read($, snapshot)
  const row = typeof a.sessionId === 'string' ? snap.rows.find(r => r.id === a.sessionId) : undefined
  const name = row ? `“${clip(row.title, 40)}”` : ''
  const needRow = (): Row => {
    if (!row) throw new Error('That session is not in the list any more')
    return row
  }
  let said: string
  switch (a.type) {
    case 'refresh':
      said = 'Refreshed'
      break
    case 'move': {
      const r = needRow()
      if (typeof a.target !== 'string' || !a.target) throw new Error('No bundle given')
      await ccd($, SIDEBAR, 'move_sessions', { session_ids: [r.id], section_id: a.target })
      said = `Moved ${name}`
      break
    }
    case 'pin': {
      const r = needRow()
      if (typeof a.pinned !== 'boolean') throw new Error('Pin or unpin?')
      await ccd($, SIDEBAR, 'set_pinned', { session_id: r.id, pinned: a.pinned })
      said = `${a.pinned ? 'Pinned' : 'Unpinned'} ${name}`
      break
    }
    case 'archive': {
      const r = needRow()
      if (r.isSelf) throw new Error('The session running the map cannot archive itself')
      await ccd($, SESSIONS, 'archive_session', {
        session_id: r.id,
        reason: 'Archived from the session map',
      })
      said = `Archived ${name}`
      break
    }
    case 'nest': {
      const r = needRow()
      const parent = typeof a.parent === 'string' ? a.parent : ''
      if (parent === r.id) throw new Error('A session cannot sit under itself')
      if (parent && !snap.rows.some(x => x.id === parent)) throw new Error('That parent is gone')
      await setNest($, r.id, parent)
      said = parent ? `Nested ${name} (map only)` : `Un-nested ${name}`
      break
    }
    case 'open': {
      const r = needRow()
      if (!(await openSession($, r.id))) throw new Error('Could not open it: open it from the sidebar')
      said = `Opening ${name}`
      break
    }
    case 'create': {
      const full = typeof a.name === 'string' ? a.name.trim() : ''
      if (!full || full.length > 200) throw new Error('A bundle needs a name of up to 200 characters')
      await ccd($, SIDEBAR, 'create_section', { name: full })
      said = `Created “${full}”`
      break
    }
    default:
      throw new Error('Unknown action')
  }
  await refresh($)
  return said
}

// ---------- shaping the tree ----------

type Node = { key: string; label: string; raw: string; section?: Section; children: Node[] }

function buildTree(sections: Section[], labels: Labels): Node[] {
  const byParent = new Map<string, Section[]>()
  for (const s of sections) {
    const parent = s.name.includes(SEP) ? (s.name.split(SEP)[0] ?? s.name) : s.name
    byParent.set(parent, [...(byParent.get(parent) ?? []), s])
  }
  const nodes: Node[] = []
  for (const [parent, secs] of byParent) {
    const isNested = secs.length > 1 || secs.some(s => s.name.includes(SEP))
    const first = secs[0]
    if (!isNested && first) {
      nodes.push({ key: `s:${first.id}`, label: first.name, raw: first.name, section: first, children: [] })
      continue
    }
    nodes.push({
      key: `p:${parent}`,
      label: labels.parents[parent] ?? parent,
      raw: parent,
      children: secs.map(s => ({
        key: `s:${s.id}`,
        label:
          s.name === parent
            ? (labels.children[parent] ?? 'General')
            : s.name.slice(parent.length + SEP.length),
        raw: s.name,
        section: s,
        children: [],
      })),
    })
  }
  return nodes
}

function rowsOf(node: Node, rows: Row[]): Row[] {
  if (node.section) return rows.filter(r => !r.pinned && r.group === node.section?.id)
  return node.children.flatMap(child => rowsOf(child, rows))
}

/** Who a session sits under: a map-only nest first, else the session that started it. */
function parentOf(r: Row, nestMap: Nests): string | null {
  return nestMap[r.id] ?? r.startedBy
}

/** Orders a list so each session follows the one it sits under, when both are in it. */
function nestedOrder(list: Row[], nestMap: Nests): { row: Row; depth: number }[] {
  const inList = new Set(list.map(r => r.id))
  const kids = new Map<string, Row[]>()
  const roots: Row[] = []
  for (const r of list) {
    const p = parentOf(r, nestMap)
    if (p && p !== r.id && inList.has(p)) kids.set(p, [...(kids.get(p) ?? []), r])
    else roots.push(r)
  }
  const out: { row: Row; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (r: Row, depth: number) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({ row: r, depth })
    for (const k of kids.get(r.id) ?? []) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const r of list) if (!seen.has(r.id)) walk(r, 0) // a loop of nests: show them flat
  return out
}

/** Sessions nested (map only) under `id`, at any depth. */
function nestDescendants(id: string, nestMap: Nests): Set<string> {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const [child, parent] of Object.entries(nestMap)) {
      if ((parent === id || out.has(parent)) && !out.has(child)) {
        out.add(child)
        grew = true
      }
    }
  }
  return out
}

// ---------- small helpers ----------

const OPEN_BY_DEFAULT = (key: string) => key.startsWith('p:') || key === 'pinned'

function isOpen(key: string, v: View): boolean {
  return OPEN_BY_DEFAULT(key) !== v.toggled.includes(key)
}

function ago(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return days < 45 ? `${days}d` : `${Math.round(days / 30)}mo`
}

function clip(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------- the mod ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bundles',
      description: 'Open the Bundles pane: your sessions grouped into bundles',
    })
    await $.command.register({
      name: 'session-map',
      description: 'Open the interactive session map in your browser',
    })
    if ((await $.store.get('labels')) === undefined) await $.store.set('labels', DEFAULT_LABELS)
    const savedNests = (await $.store.get('nests')) as Nests | undefined
    if (savedNests && Object.keys(await read($, nests)).length === 0) {
      await update($, nests, () => savedNests)
    }
    void startBridge($).catch(async err => {
      await update($, bridgeState, () => ({ url: '', status: 'unavailable', detail: message(err) }))
    })
    $.clock.every(REFRESH_MS, () => {
      void refresh($).catch(() => undefined)
      void ensureServer($).catch(() => undefined)
    })
    $.clock.every(ACTION_POLL_MS, () => void pollActions($).catch(() => undefined))
    void refresh($).catch(() => undefined)
    if ((await $.store.get('introduced')) !== true) {
      await $.store.set('introduced', true)
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('command.run', { command: 'bundles' }, async $ => {
    void refresh($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Bundles pane opened.' }
  })

  on('command.run', { command: 'session-map' }, async $ => {
    const b = await read($, bridgeState)
    if (b.status !== 'live' || !b.url) {
      return { text: `The session map is not running yet${b.detail ? `: ${b.detail}` : ''}.` }
    }
    const isOpened = await openExternal($, b.url)
    return {
      text: isOpened ? `Session map opened in your browser: ${b.url}` : `Open the session map at ${b.url}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as Elements['mobile'] &
      Partial<Pick<Elements['desktop'], 'Input' | 'Select'>>
    const { Box, Text, Button } = els
    const Select = els.Select
    const Input = els.Input

    const snap = await read($, snapshot)
    const v = await read($, view)
    const nestMap = await read($, nests)
    const map = await read($, bridgeState)
    const labels = await loadLabels($)
    const cols = Math.max(24, e.props.bodyColumns ?? 40)
    const now = snap.loadedAt || Date.now()
    const tree = buildTree(snap.sections, labels)
    const filed = new Set(snap.sections.map(s => s.id))
    const byId = new Map(snap.rows.map(r => [r.id, r]))

    const toggle = (key: string) =>
      update($, view, x => ({
        ...x,
        toggled: x.toggled.includes(key) ? x.toggled.filter(k => k !== key) : [...x.toggled, key],
      }))
    const pick = (id: string) =>
      update($, view, x => ({ ...x, selected: x.selected === id ? '' : id, confirm: '' }))

    // Where a session can be moved: every bundle, then back to Unsorted.
    const moveOptions = [
      ...tree.flatMap(node =>
        node.section
          ? [{ value: node.section.id, label: node.label }]
          : node.children.map(child => ({
              value: child.section?.id ?? '',
              label: `${node.label} › ${child.label}`,
            })),
      ),
      { value: UNSORTED, label: 'Unsorted' },
    ]

    const pinned = snap.rows.filter(r => r.pinned)
    const routines = snap.rows.filter(r => !r.pinned && r.routine)
    const unsorted = snap.rows.filter(
      r => !r.pinned && !r.routine && (r.group === null || !filed.has(r.group)),
    )
    const runningCount = snap.rows.filter(r => r.running).length

    const sessionLink = (id: string, prefix: string) => {
      const other = byId.get(id)
      if (!other) return null
      return (
        <Button key={`${prefix}:${id}`} plain onPress={() => pick(id)}>
          <Text color={other.running ? 'success' : 'inactive'}>{other.running ? '●' : '○'}</Text>{' '}
          {clip(other.title, Math.max(12, cols - 8))}
        </Button>
      )
    }

    const actions = (r: Row) => {
      const startedBy = r.startedBy ? byId.get(r.startedBy) : undefined
      const started = snap.rows.filter(x => x.startedBy === r.id)
      const nestParent = nestMap[r.id] ? byId.get(nestMap[r.id] ?? '') : undefined
      const nestedHere = snap.rows.filter(x => nestMap[x.id] === r.id)
      const blocked = nestDescendants(r.id, nestMap)
      const nestOptions = [
        { value: '', label: 'Not nested' },
        ...snap.rows
          .filter(x => x.id !== r.id && !blocked.has(x.id))
          .sort((a, b) => a.title.localeCompare(b.title))
          .map(x => ({ value: x.id, label: clip(x.title, 48) })),
      ]
      return (
        <Box key={`actions:${r.id}`} flexDirection="column" paddingLeft={2} paddingBottom={1} gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            <Button
              key={`open:${r.id}`}
              variant="primary"
              onPress={async () => {
                const isOpened = await openSession($, r.id)
                await update($, view, x => ({
                  ...x,
                  note: isOpened ? `Opening “${clip(r.title, 40)}”` : 'Could not open it: open it from the sidebar',
                }))
              }}
            >
              Open
            </Button>
            {!r.routine && (
              <Button
                key={`pin:${r.id}`}
                onPress={() =>
                  act($, r.pinned ? 'Unpin' : 'Pin', () =>
                    ccd($, SIDEBAR, 'set_pinned', { session_id: r.id, pinned: !r.pinned }),
                  )
                }
              >
                {r.pinned ? 'Unpin' : 'Pin'}
              </Button>
            )}
            {!r.isSelf && (
              <Button key={`archive:${r.id}`} onPress={() => update($, view, x => ({ ...x, confirm: r.id }))}>
                Archive
              </Button>
            )}
          </Box>
          {!r.routine && !r.pinned && Select && (
            <Select
              key={`move:${r.id}`}
              label="Move to"
              options={moveOptions}
              value={r.group && filed.has(r.group) ? r.group : UNSORTED}
              onSelect={target =>
                act($, 'Move', () =>
                  ccd($, SIDEBAR, 'move_sessions', { session_ids: [r.id], section_id: target }),
                )
              }
            />
          )}
          {Select && (
            <Select
              key={`nest:${r.id}`}
              label="Nest under"
              options={nestOptions}
              value={nestParent ? nestParent.id : ''}
              onSelect={async parent => {
                await setNest($, r.id, parent)
                await writeMapData($)
                await update($, view, x => ({
                  ...x,
                  note: parent ? 'Nested here and on the map (the app itself is unchanged)' : 'Un-nested',
                }))
              }}
            />
          )}
          {startedBy && (
            <Box flexDirection="column">
              <Text dimColor>Started by (linked: reports back to it):</Text>
              {sessionLink(startedBy.id, `from-${r.id}`)}
            </Box>
          )}
          {started.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Started (linked: they report back here):</Text>
              {started.map(x => sessionLink(x.id, `to-${r.id}`))}
            </Box>
          )}
          {nestedHere.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Nested here (map only):</Text>
              {nestedHere.map(x => sessionLink(x.id, `nest-${r.id}`))}
            </Box>
          )}
          {r.pinned && <Text dimColor>Pinned sessions stay on top. Unpin to file it in a bundle.</Text>}
          {r.routine && <Text dimColor>Scheduled run: it lives under its routine and can't be filed.</Text>}
          {v.confirm === r.id && (
            <Box flexDirection="column" gap={1}>
              <Text color="warning">
                Archive “{clip(r.title, 40)}”? Its process stops; you can restore it any time from Archived.
              </Text>
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`archive-yes:${r.id}`}
                  variant="primary"
                  onPress={() =>
                    act($, 'Archive', () =>
                      ccd($, SESSIONS, 'archive_session', {
                        session_id: r.id,
                        reason: 'Archived from the Bundles pane',
                      }),
                    )
                  }
                >
                  Archive
                </Button>
                <Button key={`archive-no:${r.id}`} onPress={() => update($, view, x => ({ ...x, confirm: '' }))}>
                  Cancel
                </Button>
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const rowView = (r: Row, depth: number) => {
      const age = ago(r.lastActivityAt, now)
      const room = Math.max(8, cols - depth * 2 - age.length - 6)
      const title = r.isSelf ? `${r.title} (this session)` : r.title
      const isChild = depth > 0 && parentOf(r, nestMap) !== null
      return (
        <Box key={`row:${r.id}`} flexDirection="column" paddingLeft={depth * 2}>
          <Button key={`pick:${r.id}`} plain onPress={() => pick(r.id)}>
            {isChild ? <Text dimColor>└ </Text> : ''}
            <Text color={r.running ? 'success' : 'inactive'}>{r.running ? '●' : '○'}</Text> {clip(title, room)}{' '}
            <Text dimColor>{age}</Text>
          </Button>
          {v.selected === r.id && actions(r)}
        </Box>
      )
    }

    const rowsNested = (list: Row[], depth: number) =>
      nestedOrder(list, nestMap).map(({ row, depth: inner }) => rowView(row, depth + inner))

    const header = (key: string, label: string, list: Row[], depth: number, dim = false) => {
      const live = list.filter(r => r.running).length
      return (
        <Box key={`head:${key}`} paddingLeft={depth * 2}>
          <Button key={`node:${key}`} plain onPress={() => toggle(key)}>
            <Text bold={!dim} dimColor={dim}>
              {isOpen(key, v) ? '▾' : '▸'} {label}
            </Text>{' '}
            <Text dimColor>{String(list.length)}</Text>
            {live > 0 ? <Text color="success"> ● {String(live)}</Text> : ''}
          </Button>
        </Box>
      )
    }

    const nodeView = (node: Node, depth: number): JSX.Element => {
      const list = rowsOf(node, snap.rows)
      const open = isOpen(node.key, v)
      return (
        <Box key={`node-box:${node.key}`} flexDirection="column">
          {header(node.key, node.label, list, depth)}
          {open && node.section && list.length === 0 && (
            <Box paddingLeft={depth * 2 + 2}>
              <Text dimColor>Empty</Text>
            </Box>
          )}
          {open && node.section && rowsNested(list, depth + 1)}
          {open && !node.section && node.children.map(child => nodeView(child, depth + 1))}
        </Box>
      )
    }

    const plainGroup = (key: string, label: string, list: Row[], dim = false) =>
      list.length === 0 ? null : (
        <Box key={`group:${key}`} flexDirection="column">
          {header(key, label, list, 0, dim)}
          {isOpen(key, v) && rowsNested(list, 1)}
        </Box>
      )

    const parentOptions = [
      { value: '', label: 'Top level' },
      ...tree.map(node => ({ value: node.raw, label: node.label })),
    ]

    const mapLine =
      map.status === 'live'
        ? 'Interactive map: drag, scroll to zoom, click for details.'
        : map.status === 'starting'
          ? 'Starting the interactive map…'
          : `Map unavailable${map.detail ? `: ${map.detail}` : ''}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Text dimColor>
            {String(snap.rows.length)} sessions · {String(runningCount)} running
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="map"
              variant="primary"
              onPress={async () => {
                const b = await read($, bridgeState)
                const isOpened = b.url ? await openExternal($, b.url) : false
                await update($, view, x => ({
                  ...x,
                  note: isOpened ? 'Map opened in your browser' : `Map not ready${b.detail ? `: ${b.detail}` : ''}`,
                }))
              }}
            >
              Map ↗
            </Button>
            <Button key="refresh" onPress={() => act($, 'Refresh', async () => undefined)}>
              Refresh
            </Button>
            <Button key="new" onPress={() => update($, view, x => ({ ...x, creating: !x.creating }))}>
              {v.creating ? 'Close' : 'New bundle'}
            </Button>
          </Box>
        </Box>
        <Text dimColor>{mapLine}</Text>

        {v.creating && Input && (
          <Box flexDirection="column" gap={1}>
            {Select && (
              <Select
                key="new-parent"
                label="Under"
                options={parentOptions}
                value={v.newParent}
                onSelect={value => update($, view, x => ({ ...x, newParent: value }))}
              />
            )}
            <Input
              key="new-name"
              placeholder="Bundle name"
              submitLabel="Create"
              autoFocus
              onSubmit={value => {
                const name = value.trim()
                if (!name) return
                const full = v.newParent ? `${v.newParent}${SEP}${name}` : name
                void act($, `Create “${full}”`, () => ccd($, SIDEBAR, 'create_section', { name: full })).then(
                  () => update($, view, x => ({ ...x, creating: false, newParent: '' })),
                )
              }}
            />
          </Box>
        )}

        {v.busy !== '' && <Text dimColor>{v.busy}…</Text>}
        {v.busy === '' && v.note !== '' && <Text dimColor>{v.note}</Text>}
        {snap.error !== undefined && <Text color="error">Couldn't load sessions: {snap.error}</Text>}
        {snap.loadedAt === 0 && snap.error === undefined && <Text dimColor>Loading sessions…</Text>}

        <Box flexDirection="column">
          {plainGroup('pinned', 'Pinned', pinned)}
          {tree.map(node => nodeView(node, 0))}
          {plainGroup('unsorted', 'Unsorted', unsorted)}
          {plainGroup('routines', 'Scheduled runs', routines, true)}
        </Box>
      </Box>
    )
  })
}
