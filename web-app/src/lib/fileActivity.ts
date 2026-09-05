/**
 * What a conversation did to which files.
 *
 * Built from the *structured* tool calls a run already records — the name the
 * tool was called with and the arguments it was given — never from the
 * assistant's prose. A sentence claiming a file was written is not evidence
 * that it was, and a list that is sometimes wrong is worse than no list.
 *
 * Only references are stored. Contents already live in the transcript and, for
 * writes, in the diff the tool produced; copying them here would double the
 * session's size to say something the session already says.
 */

export type FileOperation =
  | 'read'
  | 'list'
  | 'search'
  | 'create'
  | 'write'
  | 'edit'
  | 'delete'
  | 'rename'

/** Where the path lives, which decides what may be done with it. */
export type FileOrigin =
  /** Inside the attached project folder. Read-only. */
  | 'project'
  /** The session's writable sandbox. */
  | 'sandbox'
  /** An artifact the agent produced. */
  | 'artifact'
  /** Opened from outside both roots. */
  | 'external'

export type FileActivityEvent = {
  /** Stable id, so a re-render or a reload cannot duplicate a row. */
  id: string
  /** Normalized, root-relative where possible. */
  path: string
  operation: FileOperation
  /** Ordering within the conversation; monotonic, not wall-clock-dependent. */
  seq: number
  at: number
  /** The structured call this came from, so the row can point back at it. */
  toolCallId?: string
  /** Which agent did it: the main one, or a named subagent. */
  agent?: string
  ok: boolean
  /** Why it failed, when it did. */
  error?: string
  origin: FileOrigin
  /** A diff already recorded for this call; referenced, never copied. */
  hasDiff?: boolean
}

/** Tool name to the operation it performs. Anything absent is not file work. */
const TOOL_OPERATIONS: Record<string, FileOperation> = {
  read: 'read',
  project_read_file: 'read',
  ls: 'list',
  project_list_dir: 'list',
  find: 'search',
  grep: 'search',
  write: 'write',
  edit: 'edit',
  create: 'create',
  delete: 'delete',
  rm: 'delete',
  move: 'rename',
  rename: 'rename',
}

export const operationForTool = (tool: string): FileOperation | null =>
  TOOL_OPERATIONS[tool] ?? null

/** Operations that changed something on disk. */
const CHANGING = new Set<FileOperation>([
  'create',
  'write',
  'edit',
  'delete',
  'rename',
])

export const isChange = (op: FileOperation): boolean => CHANGING.has(op)

/**
 * Normalize a path for grouping.
 *
 * Windows separators become POSIX ones so the same file from two platforms is
 * one row, `.` segments are dropped, and a trailing slash is removed. `..` is
 * left alone deliberately: collapsing it here would let a traversal look like
 * a contained path, and containment is the backend's decision, not a display
 * helper's.
 */
export function normalizePath(raw: string): string {
  const unified = raw.replace(/\\/g, '/')
  const parts = unified.split('/')
  const kept: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') {
      // Keep a leading empty segment so an absolute path stays absolute.
      if (kept.length === 0 && part === '') kept.push('')
      continue
    }
    kept.push(part)
  }
  const joined = kept.join('/')
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined
}

/** The last segment, for the row's title. */
export const baseName = (path: string): string =>
  normalizePath(path).split('/').filter(Boolean).pop() ?? path

/** The argument a tool was called with that names a file, if any. */
export function pathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  for (const key of ['path', 'file', 'file_path', 'filename', 'target', 'dir']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export type ToolRecord = {
  callId?: string
  /** The subagent that ran it, when it was not the main agent. */
  name?: string
  args?: unknown
  result?: string
  isError?: boolean
  diff?: string
  status?: 'running' | 'done'
  agent?: string
}

/**
 * Turn one structured tool record into an event, or nothing.
 *
 * A call still running is not yet activity: it has not done anything, and
 * recording it would show a write that may never land.
 */
export function eventFromTool(
  record: ToolRecord,
  seq: number,
  at: number,
  originOf: (path: string) => FileOrigin
): FileActivityEvent | null {
  if (!record.name) return null
  if (record.status === 'running') return null
  const operation = operationForTool(record.name)
  if (!operation) return null
  const raw = pathFromArgs(record.args)
  if (!raw) return null

  const path = normalizePath(raw)
  return {
    // Keyed on the tool call, not on where it fell in a batch. A call settles
    // once but is seen twice — as the step lands, and again when the turn is
    // committed — and a batch-relative id would make those two different
    // events. The call id is the thing that is actually unique.
    id: record.callId ? `call:${record.callId}` : `${path}:${seq}`,
    path,
    operation,
    seq,
    at,
    toolCallId: record.callId,
    agent: record.agent,
    ok: !record.isError,
    origin: originOf(path),
    hasDiff: Boolean(record.diff),
  }
}

/**
 * Events for one subagent's turns, tagged with its name.
 *
 * A subagent's file work is the conversation's file work; without the name the
 * activity view cannot say who touched what.
 */
export function deriveFromSubagent(
  name: string,
  turns: readonly ToolRecord[],
  originOf: (path: string) => FileOrigin,
  startedAt = 0
): FileActivityEvent[] {
  return deriveFromTurns(
    turns.map((turn) => ({ ...turn, agent: turn.agent ?? name })),
    originOf,
    startedAt
  )
}

/**
 * Best-effort history for a conversation that predates this record.
 *
 * Derived only from structured tool rows already in the transcript, so an old
 * session shows what it can prove and nothing more.
 */
export function deriveFromTurns(
  turns: readonly ToolRecord[],
  originOf: (path: string) => FileOrigin,
  startedAt = 0
): FileActivityEvent[] {
  const events: FileActivityEvent[] = []
  turns.forEach((turn, index) => {
    const event = eventFromTool(turn, index, startedAt + index, originOf)
    if (event) events.push(event)
  })
  return events
}

export type FileActivityFilter =
  | 'all'
  | 'read'
  | 'changed'
  | 'created'
  | 'deleted'
  | 'failed'
  | 'project'
  | 'sandbox'

export function matchesFilter(
  event: FileActivityEvent,
  filter: FileActivityFilter
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'read':
      return event.operation === 'read' || event.operation === 'list' || event.operation === 'search'
    case 'changed':
      return isChange(event.operation)
    case 'created':
      return event.operation === 'create'
    case 'deleted':
      return event.operation === 'delete'
    case 'failed':
      return !event.ok
    case 'project':
      return event.origin === 'project'
    case 'sandbox':
      return event.origin === 'sandbox'
  }
}

export type FileActivityGroup = {
  path: string
  name: string
  events: FileActivityEvent[]
  /** Most recent activity, for ordering and for the row's caption. */
  lastAt: number
  /** Anything changed this file. */
  changed: boolean
  /** Anything failed against it. */
  failed: boolean
  origin: FileOrigin
}

/**
 * Group events by file, most recently touched first.
 *
 * Grouping is the default because the question is almost always "what
 * happened to this file", not "what happened at 14:03".
 */
export function groupByFile(
  events: readonly FileActivityEvent[],
  options: { filter?: FileActivityFilter; search?: string } = {}
): FileActivityGroup[] {
  const filter = options.filter ?? 'all'
  const needle = options.search?.trim().toLowerCase() ?? ''

  const groups = new Map<string, FileActivityGroup>()
  for (const event of events) {
    if (!matchesFilter(event, filter)) continue
    if (needle && !event.path.toLowerCase().includes(needle)) continue

    const existing = groups.get(event.path)
    if (existing) {
      existing.events.push(event)
      existing.lastAt = Math.max(existing.lastAt, event.at)
      existing.changed ||= isChange(event.operation)
      existing.failed ||= !event.ok
    } else {
      groups.set(event.path, {
        path: event.path,
        name: baseName(event.path),
        events: [event],
        lastAt: event.at,
        changed: isChange(event.operation),
        failed: !event.ok,
        origin: event.origin,
      })
    }
  }

  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/** Counts for the filter chips, so each says how much it would show. */
export function countsByFilter(
  events: readonly FileActivityEvent[]
): Record<FileActivityFilter, number> {
  const filters: FileActivityFilter[] = [
    'all',
    'read',
    'changed',
    'created',
    'deleted',
    'failed',
    'project',
    'sandbox',
  ]
  const counts = {} as Record<FileActivityFilter, number>
  for (const filter of filters) {
    counts[filter] = events.filter((e) => matchesFilter(e, filter)).length
  }
  return counts
}

/** Merge new events in without duplicating one already recorded. */
export function mergeEvents(
  existing: readonly FileActivityEvent[],
  incoming: readonly FileActivityEvent[]
): FileActivityEvent[] {
  const seen = new Set(existing.map((e) => e.id))
  const added = incoming.filter((e) => !seen.has(e.id))
  return added.length ? [...existing, ...added] : (existing as FileActivityEvent[])
}
