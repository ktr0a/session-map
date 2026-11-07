import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSIONS = [
  {
    sessionId: 'a',
    title: 'Release coordinator',
    group: { id: 'g-work', name: 'Work' },
    isRunning: true,
    lastActivityAt: '2026-11-07T12:00:00Z',
  },
  {
    sessionId: 'b',
    title: 'Literature review',
    group: { id: 'g-research', name: 'Work · Research' },
    lastActivityAt: '2026-11-01T12:00:00Z',
  },
  { sessionId: 'c', title: 'Loose one', group: null, lastActivityAt: '2026-11-01T12:00:00Z' },
  { sessionId: 'd', title: 'Daily standup notes', group: null, lastActivityAt: '2026-11-01T12:00:00Z' },
  {
    sessionId: 'e',
    title: 'Fix flaky CI tests',
    group: { id: 'g-work', name: 'Work' },
    startedBy: 'a',
    lastActivityAt: '2026-11-07T11:00:00Z',
  },
]
const SECTIONS = [
  { id: 'pinned', kind: 'pinned', name: '', order: 0 },
  { id: 'g-work', kind: 'manual', name: 'Work', order: 2, shown: true },
  { id: 'g-research', kind: 'manual', name: 'Work · Research', order: 3, shown: true },
  { id: 'g-qn', kind: 'manual', name: 'Quiet Notes', order: 4, shown: true },
  { id: 'sessions', kind: 'sessions', name: '', order: 5 },
]

const PANE = {
  plugin: 'session-map',
  component: 'Pane',
  requestId: 'session-map',
  props: {
    title: 'Bundles',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const reply = (data: unknown) => ({
  value: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false },
})

type Call = { tool: string; args: Record<string, unknown> }
const MAP = 'C:/home/.claude/session-map'

/** Stands for the app and this computer: its tools, files and env, from memory. */
function app(on: On, calls: Call[], files: Map<string, string> = new Map()) {
  const clock = mock.clock(on)
  mock.store(on, { labels: { parents: { Work: 'Projects' }, children: { Work: 'Coordination' } } })
  on('mcp.call', (_, e) => {
    const args = (e.args ?? {}) as Record<string, unknown>
    calls.push({ tool: e.tool, args })
    if (e.tool === 'list_sessions') return reply(SESSIONS)
    if (e.tool === 'list_sections') return reply(SECTIONS)
    if (e.tool === 'get_session') {
      if (args.session_id === 'self') {
        return reply({ sessionId: 'me', title: 'Organise my sessions', group: null })
      }
      return reply({
        sessionId: args.session_id,
        ...(args.session_id === 'd' ? { scheduledTaskId: 'daily' } : {}),
      })
    }
    return reply('ok')
  })
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\home' : undefined }))
  // The engine hands paths over in the platform's own spelling.
  const norm = (p: string) => p.split('\\').join('/')
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error('missing')
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', (_, e) => {
    const prefix = `${norm(e.path)}/`
    const names = [...files.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
    return {
      value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
    }
  })
  on('command.register', () => ({ value: { command: 'bundles' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return clock
}

const READS = ['list_sessions', 'list_sections', 'get_session']

test('the list nests bundles by name and keeps unsorted and scheduled runs apart', async ($, on) => {
  const calls: Call[] = []
  app(on, calls)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Projects/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Coordination/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Unsorted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Scheduled runs/ })).toBeDefined()
    await ui.unmount()
  }
  // Nothing was changed just by looking.
  expect(calls.every(c => READS.includes(c.tool))).toBe(true)
})

test('the map gets its page, server and live data written out', async ($, on) => {
  const files = new Map<string, string>()
  const clock = app(on, [], files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect(files.get(`${MAP}/index.html`)).toContain('Session map')
  expect(files.get(`${MAP}/server.mjs`)).toContain('session-map server on')
  expect(files.get(`${MAP}/token.txt`)?.length).toBeGreaterThan(16)
  const data = JSON.parse(files.get(`${MAP}/data.json`) ?? '{}') as {
    rows: { id: string; startedBy: string | null }[]
  }
  expect(data.rows.find(r => r.id === 'e')?.startedBy).toBe('a')
  await ui.unmount()
})

test('a move asked for on the map is carried out and answered', async ($, on) => {
  const calls: Call[] = []
  const files = new Map<string, string>()
  const clock = app(on, calls, files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  files.set(
    `${MAP}/actions/1-x.json`,
    JSON.stringify({ id: '1-x', type: 'move', sessionId: 'c', target: 'g-qn' }),
  )
  await clock.advance(1_100)
  await clock.settle()

  expect(calls.find(c => c.tool === 'move_sessions')?.args).toEqual({
    session_ids: ['c'],
    section_id: 'g-qn',
  })
  expect(JSON.parse(files.get(`${MAP}/results/1-x.json`) ?? '{}')).toEqual({
    ok: true,
    message: 'Moved “Loose one”',
  })
  await ui.unmount()
})

test('the map cannot archive the session that runs it, and unknown asks are refused', async ($, on) => {
  const calls: Call[] = []
  const files = new Map<string, string>()
  const clock = app(on, calls, files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  files.set(`${MAP}/actions/2-a.json`, JSON.stringify({ id: '2-a', type: 'archive', sessionId: 'me' }))
  files.set(`${MAP}/actions/2-b.json`, JSON.stringify({ id: '2-b', type: 'delete', sessionId: 'c' }))
  await clock.advance(1_100)
  await clock.settle()

  expect(JSON.parse(files.get(`${MAP}/results/2-a.json`) ?? '{}').ok).toBe(false)
  expect(JSON.parse(files.get(`${MAP}/results/2-b.json`) ?? '{}').ok).toBe(false)
  expect(calls.some(c => c.tool === 'archive_session')).toBe(false)
  await ui.unmount()
})

test('nesting a session is map-only and calls no app tool', async ($, on) => {
  const calls: Call[] = []
  app(on, calls)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'node:unsorted' })
  await ui.press({ key: 'pick:c' })
  await ui.select({ key: 'nest:c', value: 'a' })
  expect(await ui.find({ type: 'Text', text: /Nested here and on the map/ })).toBeDefined()
  expect(calls.every(c => READS.includes(c.tool))).toBe(true)
  await ui.unmount()
})

test('moving a session in the pane files it through the sidebar tool', async ($, on) => {
  const calls: Call[] = []
  app(on, calls)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'node:unsorted' })
  await ui.press({ key: 'pick:c' })
  await ui.select({ key: 'move:c', value: 'g-qn' })
  const move = calls.find(c => c.tool === 'move_sessions')
  expect(move?.args).toEqual({ session_ids: ['c'], section_id: 'g-qn' })
  await ui.unmount()
})
