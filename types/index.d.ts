/** One session as the pane lists it. */
export type Row = {
  id: string
  title: string
  /** The sidebar section (custom group) id it is filed under, or null. */
  group: string | null
  pinned: boolean
  running: boolean
  lastActivityAt: string
  /** A scheduled-task run: it lives under its routine and can't be filed. */
  routine: boolean
  /** The session this pane is drawn in. */
  isSelf: boolean
  /** The session that started this one (a real link: they can message each other). */
  startedBy: string | null
}

/** One custom sidebar section. */
export type Section = { id: string; name: string; order: number }

export type Snapshot = {
  rows: Row[]
  sections: Section[]
  loadedAt: number
  error?: string
}

export type View = {
  /** Node keys whose open/closed state differs from the default. */
  toggled: string[]
  selected: string
  confirm: string
  busy: string
  note: string
  creating: boolean
  newParent: string
}

/** The local map server: where the interactive graph is served, and how it is doing. */
export type Bridge = { url: string; status: 'starting' | 'live' | 'stopped' | 'unavailable'; detail: string }

/** Map-only nesting: child session id to parent session id. */
export type Nests = Record<string, string>

/** Display names: a parent bundle's title, and a parent section's own branch. */
export type Labels = {
  parents: Record<string, string>
  children: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'session-map': {
      snapshot: Shaped<Snapshot>
      view: Shaped<View>
      nests: Shaped<Nests>
      bridge: Shaped<Bridge>
    }
  }
}
