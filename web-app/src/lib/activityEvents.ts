/**
 * The canonical model of what a run actually did (AH-201).
 *
 * Four surfaces report on the same work today and none of them share a store:
 * the inline conversation renders a transient stream, the activity rail renders a
 * one-line label, the Background Tasks panel keeps its own model of dispatched
 * work, and the audit export reads the Rust event log. Four models of one run is
 * four chances to disagree about it, and a user who sees a different answer in
 * two places trusts neither.
 *
 * So this is one append-only log of observable execution events per session, and
 * every surface is a projection of it. `coworkActivity.ts` stays the model of
 * *background* work (tasks, phases, workflows) and keeps its arithmetic; this is
 * the wider record every event lands in, including the ones background work
 * generates.
 *
 * ## What an event is allowed to be
 *
 * Observable execution facts only. A read with its path and line range, a write
 * with its diff and line counts, a command with its working directory, duration,
 * exit code and output, a permission request and the decision that answered it,
 * a retry, a cancellation, a git operation.
 *
 * Never the model's reasoning. Not a paraphrase of it, not a "thinking" summary,
 * not an inferred intent. The line is not stylistic: reasoning is the one part of
 * a run that is neither an action nor its result, and a timeline that mixes the
 * two invites a reader to treat a guess as a fact. Where a summary is useful, it
 * is a summary of what happened -- `title` is derived from the action, not from
 * anything the model said about it.
 *
 * ## Ordering, identity and lateness
 *
 * Events arrive from a stream that is concurrent (a parent and its subagents), can
 * repeat (a reconnect replays), and can be late (a backgrounded command finishes
 * after the turn that started it). So:
 *
 * - `id` is the event's identity and is stable. Appending the same id twice is a
 *   no-op, not a duplicate row: a replayed stream must not double the timeline.
 * - `seq` is assigned on append and only breaks ties. It is not the order: `at`
 *   is, because a late event belongs where it happened, not at the end.
 * - An event that *updates* one already in the log (a command that started and
 *   later exited) is an upsert on the same id, so the row keeps its position.
 *
 * ## Redaction
 *
 * Everything here is persisted, so everything is redacted on the way in, using
 * the detector shared with the Rust core (`secretRedaction.ts`). It happens at
 * ingest rather than at render because there is exactly one ingest and four
 * renderers, and because what reaches `localStorage` is what matters.
 *
 * Pure and store-free on purpose, like `coworkActivity.ts`: every rule below is
 * testable without React, zustand or a running agent.
 */

import { redactSecrets, redactSecretsDeep } from './secretRedaction'

/**
 * The kinds of event a run produces. Dotted names group them for filtering
 * (`file.`, `command.`, `permission.`) without a second category field.
 */
export type ActivityEventKind =
  | 'run.started'
  | 'run.finished'
  | 'turn.started'
  | 'turn.finished'
  | 'file.read'
  | 'file.created'
  | 'file.edited'
  | 'file.deleted'
  | 'file.moved'
  | 'command'
  | 'verification'
  | 'permission.requested'
  | 'permission.decided'
  | 'task.started'
  | 'task.finished'
  | 'phase.entered'
  | 'git'
  | 'retry'
  | 'cancelled'
  | 'failure'
  | 'recovered'

/** How the thing the event describes turned out. `pending` is still in flight. */
export type ActivityEventStatus = 'pending' | 'ok' | 'error' | 'cancelled'

/** A file read, with the range that was actually returned. */
export type ReadDetail = {
  path: string
  /** 1-based, inclusive. Absent when the whole file was read. */
  fromLine?: number
  toLine?: number
  /** Lines returned, after any truncation the tool applied. */
  lines?: number
  truncated?: boolean
}

/** A write, edit, delete or move, with what changed. */
export type ChangeDetail = {
  path: string
  /** For a move or rename: where it came from. */
  fromPath?: string
  /** Line-prefixed hunk text, display-only, already redacted. */
  diff?: string
  added?: number
  removed?: number
  /** Size of the file after the change, in bytes, when the tool reported it. */
  bytes?: number
}

/** A shell command, with everything needed to judge it without re-running it. */
export type CommandDetail = {
  command: string
  cwd?: string
  exitCode?: number
  durationMs?: number
  stdout?: string
  stderr?: string
  /** True when the command was backgrounded and its output arrives later. */
  background?: boolean
  jobId?: string
  /** Set when output was clamped for storage; the full text is not kept. */
  outputTruncated?: boolean
}

/** A test, build, lint or other verification run, and how it came out. */
export type VerificationDetail = CommandDetail & {
  tool: 'test' | 'build' | 'lint' | 'typecheck' | 'other'
  passed?: number
  failed?: number
  skipped?: number
}

/** A permission request and, once answered, the decision. */
export type PermissionDetail = {
  requestId: string
  tool: string
  promptKind: string
  /** The redacted resource -- a path, or the command being vouched for. */
  resource?: string
  decision?: 'allow_once' | 'allow_always' | 'deny' | 'auto_allowed' | 'expired'
  /** Who or what answered. `user` for a person, `policy` for agent.toml. */
  decidedBy?: 'user' | 'policy' | 'timeout' | 'kill_switch'
  scope?: string
}

/** Background work: a dispatched subagent or a shell task. */
export type TaskDetail = {
  taskId: string
  name: string
  phase?: string
  kind: 'agent' | 'shell'
  durationMs?: number
}

/** A git operation, named by what it did rather than by its flags. */
export type GitDetail = {
  operation:
    | 'status'
    | 'commit'
    | 'branch'
    | 'checkout'
    | 'push'
    | 'pull'
    | 'merge'
    | 'stash'
    | 'other'
  branch?: string
  /** Short SHA for a commit. */
  sha?: string
  filesChanged?: number
  insertions?: number
  deletions?: number
  remote?: string
  /** True when the operation was classified as destructive (AH-046). */
  destructive?: boolean
}

/** A retry, a cancellation, a failure or a recovery, and why. */
export type OutcomeDetail = {
  /** What is being retried, cancelled or recovered -- a tool, a turn, a run. */
  subject: string
  reason?: string
  attempt?: number
  of?: number
}

export type ActivityDetail =
  | { kind: 'read'; read: ReadDetail }
  | { kind: 'change'; change: ChangeDetail }
  | { kind: 'command'; command: CommandDetail }
  | { kind: 'verification'; verification: VerificationDetail }
  | { kind: 'permission'; permission: PermissionDetail }
  | { kind: 'task'; task: TaskDetail }
  | { kind: 'git'; git: GitDetail }
  | { kind: 'outcome'; outcome: OutcomeDetail }
  | { kind: 'none' }

/** One observable thing that happened. */
export type ActivityEvent = {
  /** Stable identity. Appending the same id twice updates, never duplicates. */
  id: string
  /** Assigned on append; breaks ties in `at`, and is never the ordering itself. */
  seq: number
  /** When it happened, epoch ms. */
  at: number
  /** The session this belongs to. Nothing crosses sessions. */
  sessionId: string
  runId?: string
  /** Which agent produced it: the parent run, or a named subagent. */
  agentId?: string
  modelId?: string
  /** The provider tool-call id, where one exists -- how a row links to its call. */
  callId?: string
  /** The event this is nested under: a subagent's task event, or a turn. */
  parentId?: string
  kind: ActivityEventKind
  status: ActivityEventStatus
  /** One safe line, derived from the action. Never from the model's reasoning. */
  title: string
  detail: ActivityDetail
}

/** An append-only log for one session. */
export type ActivityLog = {
  sessionId: string
  events: ActivityEvent[]
  /** Next `seq` to hand out. Monotonic for the life of the log. */
  nextSeq: number
  /** Events dropped by the cap, so a truncated timeline can say so. */
  dropped: number
}

/**
 * Events kept per session.
 *
 * A long run can produce tens of thousands; keeping all of them in a persisted
 * store would make every write slower until the app stalled. The oldest are
 * dropped and the count is reported, because a timeline that silently lost its
 * beginning is worse than one that admits it.
 */
export const MAX_EVENTS_PER_SESSION = 2000

/** Longest command output stored per event. Live output is not clamped. */
export const MAX_STORED_OUTPUT = 4000

export function emptyActivityLog(sessionId: string): ActivityLog {
  return { sessionId, events: [], nextSeq: 1, dropped: 0 }
}

/** The input to an append: everything except the fields the log assigns. */
export type IncomingActivityEvent = Omit<ActivityEvent, 'seq'> & { seq?: number }

/**
 * Append or update one event, returning a new log.
 *
 * The rules, in the order they apply:
 *
 * 1. An event for another session is rejected outright. Session isolation is not
 *    a filter applied at render; a log holds one session's events and nothing
 *    else, so a mis-addressed event cannot leak by a forgotten `where`.
 * 2. A known id is an update in place: the row keeps its `seq` and its position,
 *    and only the fields present in the incoming event change. This is how a
 *    command that started becomes a command that exited.
 * 3. A new id is inserted by `at`, then `seq`. Late events land where they
 *    happened rather than at the end.
 * 4. Strings are redacted on the way in.
 */
export function appendActivityEvent(
  log: ActivityLog,
  incoming: IncomingActivityEvent
): ActivityLog {
  if (incoming.sessionId !== log.sessionId) return log

  const existingIndex = log.events.findIndex((e) => e.id === incoming.id)
  if (existingIndex !== -1) {
    const existing = log.events[existingIndex]
    const merged = redactEvent({
      ...existing,
      ...incoming,
      // Identity and position are the log's, not the caller's: an update must
      // not be able to move a row it did not create.
      seq: existing.seq,
      at: existing.at,
      detail: mergeDetail(existing.detail, incoming.detail),
    })
    const events = log.events.slice()
    events[existingIndex] = merged
    return { ...log, events }
  }

  const event = redactEvent({ ...incoming, seq: incoming.seq ?? log.nextSeq })
  const events = log.events.slice()
  const at = insertionIndex(events, event)
  events.splice(at, 0, event)

  let dropped = log.dropped
  let trimmed = events
  if (events.length > MAX_EVENTS_PER_SESSION) {
    const excess = events.length - MAX_EVENTS_PER_SESSION
    trimmed = events.slice(excess)
    dropped += excess
  }
  return {
    ...log,
    events: trimmed,
    nextSeq: Math.max(log.nextSeq, event.seq) + 1,
    dropped,
  }
}

/** Append many, in one pass, with the same rules. */
export function appendActivityEvents(
  log: ActivityLog,
  incoming: IncomingActivityEvent[]
): ActivityLog {
  return incoming.reduce(appendActivityEvent, log)
}

/**
 * Patch one event by id. Returns the log unchanged when the id is unknown, which
 * is the normal case for an out-of-order update whose event was already dropped
 * by the cap -- a lost patch must not resurrect a row with no beginning.
 */
export function patchActivityEvent(
  log: ActivityLog,
  id: string,
  patch: Partial<Omit<ActivityEvent, 'id' | 'seq' | 'sessionId' | 'at'>>
): ActivityLog {
  const index = log.events.findIndex((e) => e.id === id)
  if (index === -1) return log
  const events = log.events.slice()
  events[index] = redactEvent({
    ...events[index],
    ...patch,
    detail: mergeDetail(events[index].detail, patch.detail),
  })
  return { ...log, events }
}

/**
 * Mark every in-flight event cancelled, for when a run is stopped.
 *
 * Cancellation has to be visible on the rows that were running, not only as one
 * "cancelled" line at the end: a timeline that leaves three commands spinning
 * forever after a stop is telling the reader they are still running.
 */
export function cancelInFlight(
  log: ActivityLog,
  at: number,
  reason?: string
): ActivityLog {
  const events = log.events.map((event) =>
    event.status === 'pending' ? { ...event, status: 'cancelled' as const } : event
  )
  // The cancellation is itself an event, so a reload still says the run was
  // stopped rather than showing a timeline that merely stops.
  return appendActivityEvent(
    { ...log, events },
    {
      id: `cancel-${at}`,
      at,
      sessionId: log.sessionId,
      kind: 'cancelled',
      status: 'cancelled',
      title: 'Run cancelled',
      detail: { kind: 'outcome', outcome: { subject: 'run', reason } },
    }
  )
}

/** Where a new event belongs: ordered by `at`, then `seq`. */
function insertionIndex(events: ActivityEvent[], event: ActivityEvent): number {
  // Scanning from the end is the common case in one comparison: events usually
  // arrive in order, and a late one is usually only slightly late.
  let i = events.length
  while (i > 0) {
    const previous = events[i - 1]
    if (previous.at < event.at) break
    if (previous.at === event.at && previous.seq <= event.seq) break
    i -= 1
  }
  return i
}

/** An update carries only the fields it changes; the rest of the detail stays. */
function mergeDetail(
  existing: ActivityDetail,
  incoming: ActivityDetail | undefined
): ActivityDetail {
  if (!incoming) return existing
  if (incoming.kind === 'none') return existing
  if (existing.kind !== incoming.kind) return incoming
  switch (incoming.kind) {
    case 'read':
      return { kind: 'read', read: { ...(existing as { read: ReadDetail }).read, ...incoming.read } }
    case 'change':
      return {
        kind: 'change',
        change: { ...(existing as { change: ChangeDetail }).change, ...incoming.change },
      }
    case 'command':
      return {
        kind: 'command',
        command: { ...(existing as { command: CommandDetail }).command, ...incoming.command },
      }
    case 'verification':
      return {
        kind: 'verification',
        verification: {
          ...(existing as { verification: VerificationDetail }).verification,
          ...incoming.verification,
        },
      }
    case 'permission':
      return {
        kind: 'permission',
        permission: {
          ...(existing as { permission: PermissionDetail }).permission,
          ...incoming.permission,
        },
      }
    case 'task':
      return { kind: 'task', task: { ...(existing as { task: TaskDetail }).task, ...incoming.task } }
    case 'git':
      return { kind: 'git', git: { ...(existing as { git: GitDetail }).git, ...incoming.git } }
    case 'outcome':
      return {
        kind: 'outcome',
        outcome: { ...(existing as { outcome: OutcomeDetail }).outcome, ...incoming.outcome },
      }
    default:
      return incoming
  }
}

/** Redact every string, and clamp the output fields that can be unbounded. */
function redactEvent(event: ActivityEvent): ActivityEvent {
  const detail = redactSecretsDeep(clampDetail(event.detail))
  return { ...event, title: redactSecrets(event.title), detail }
}

function clampDetail(detail: ActivityDetail): ActivityDetail {
  if (detail.kind === 'command' || detail.kind === 'verification') {
    const source = detail.kind === 'command' ? detail.command : detail.verification
    const stdout = clampText(source.stdout)
    const stderr = clampText(source.stderr)
    const clamped = {
      ...source,
      stdout: stdout.text,
      stderr: stderr.text,
      outputTruncated: source.outputTruncated || stdout.truncated || stderr.truncated,
    }
    return detail.kind === 'command'
      ? { kind: 'command', command: clamped }
      : { kind: 'verification', verification: clamped as VerificationDetail }
  }
  return detail
}

/**
 * Clamp stored text, keeping the tail.
 *
 * The tail, not the head: a failing command's useful line is its last one, and a
 * build that printed 90 kilobytes of progress before an error would otherwise be
 * stored as 4 kilobytes of progress.
 */
export function clampText(
  text: string | undefined,
  max = MAX_STORED_OUTPUT
): { text?: string; truncated: boolean } {
  if (text === undefined) return { text: undefined, truncated: false }
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(text.length - max), truncated: true }
}

// ── selectors ────────────────────────────────────────────────────────────────

export type ActivityFilter = {
  /** Exact kinds, or a dotted prefix (`file.` matches every file event). */
  kinds?: string[]
  statuses?: ActivityEventStatus[]
  /** Case-insensitive substring over the title and the detail's own strings. */
  query?: string
  callId?: string
  runId?: string
  agentId?: string
  /** Only events at or after this time. */
  since?: number
}

/** The events a filter selects, in log order. */
export function filterActivity(
  log: ActivityLog,
  filter: ActivityFilter
): ActivityEvent[] {
  const query = filter.query?.trim().toLowerCase()
  return log.events.filter((event) => {
    if (filter.kinds?.length && !matchesKind(event.kind, filter.kinds)) return false
    if (filter.statuses?.length && !filter.statuses.includes(event.status)) return false
    if (filter.callId && event.callId !== filter.callId) return false
    if (filter.runId && event.runId !== filter.runId) return false
    if (filter.agentId && event.agentId !== filter.agentId) return false
    if (filter.since !== undefined && event.at < filter.since) return false
    if (query && !searchableText(event).includes(query)) return false
    return true
  })
}

function matchesKind(kind: ActivityEventKind, wanted: string[]): boolean {
  return wanted.some((w) => (w.endsWith('.') ? kind.startsWith(w) : kind === w))
}

/**
 * Everything about an event a search should match: its title, and every string in
 * its detail. Searching the detail is what makes "find the command that touched
 * `Cargo.toml`" work when the title only names the tool.
 */
export function searchableText(event: ActivityEvent): string {
  const parts: string[] = [event.title, event.kind, event.status]
  collectStrings(event.detail, parts)
  return parts.join('   ').toLowerCase()
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value)
    return
  }
  if (typeof value === 'number') {
    into.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into)
  }
}

/** How many events of each status, for a header that does not lie by omission. */
export function activityCounts(
  log: ActivityLog
): Record<ActivityEventStatus, number> & { total: number } {
  const counts = { pending: 0, ok: 0, error: 0, cancelled: 0, total: 0 }
  for (const event of log.events) {
    counts[event.status] += 1
    counts.total += 1
  }
  return counts
}

/** The events for one tool call, which is what an inline row expands to show. */
export function eventsForCall(log: ActivityLog, callId: string): ActivityEvent[] {
  return log.events.filter((event) => event.callId === callId)
}

/**
 * A file path and line a row navigates to, or null when there is nothing to open.
 *
 * One place decides this so the inline row, the rail and the panel all navigate
 * identically -- and so a kind that has no location cannot silently render a
 * dead "open" affordance.
 */
export function navigationTarget(
  event: ActivityEvent
): { path: string; line?: number } | null {
  switch (event.detail.kind) {
    case 'read':
      return { path: event.detail.read.path, line: event.detail.read.fromLine }
    case 'change':
      return { path: event.detail.change.path }
    default:
      return null
  }
}

/** Whether a row has anything worth expanding, so a chevron is never a lie. */
export function hasExpandableDetail(event: ActivityEvent): boolean {
  switch (event.detail.kind) {
    case 'change':
      return Boolean(event.detail.change.diff)
    case 'command':
      return Boolean(event.detail.command.stdout || event.detail.command.stderr)
    case 'verification':
      return Boolean(
        event.detail.verification.stdout || event.detail.verification.stderr
      )
    case 'permission':
      return Boolean(event.detail.permission.resource)
    case 'read':
      return event.detail.read.fromLine !== undefined
    default:
      return false
  }
}

/**
 * The text a copy action puts on the clipboard for one event.
 *
 * Built here rather than in the component so every surface copies the same thing,
 * and so what is copied is the redacted record -- copying must not be a way to
 * get the unredacted value back, because there isn't one to get.
 */
export function copyTextFor(event: ActivityEvent): string {
  const lines: string[] = [event.title]
  const d = event.detail
  switch (d.kind) {
    case 'read':
      lines.push(
        d.read.fromLine
          ? `${d.read.path}:${d.read.fromLine}${d.read.toLine ? `-${d.read.toLine}` : ''}`
          : d.read.path
      )
      break
    case 'change':
      lines.push(d.change.fromPath ? `${d.change.fromPath} -> ${d.change.path}` : d.change.path)
      if (d.change.added !== undefined || d.change.removed !== undefined) {
        lines.push(`+${d.change.added ?? 0} -${d.change.removed ?? 0}`)
      }
      if (d.change.diff) lines.push('', d.change.diff)
      break
    case 'command':
    case 'verification': {
      const c = d.kind === 'command' ? d.command : d.verification
      lines.push(c.command)
      if (c.cwd) lines.push(`cwd: ${c.cwd}`)
      if (c.exitCode !== undefined) lines.push(`exit: ${c.exitCode}`)
      if (c.durationMs !== undefined) lines.push(`took: ${c.durationMs}ms`)
      if (c.stdout) lines.push('', c.stdout)
      if (c.stderr) lines.push('', c.stderr)
      break
    }
    case 'permission':
      lines.push(`${d.permission.tool} (${d.permission.promptKind})`)
      if (d.permission.resource) lines.push(d.permission.resource)
      if (d.permission.decision) {
        lines.push(
          `decision: ${d.permission.decision}${
            d.permission.decidedBy ? ` by ${d.permission.decidedBy}` : ''
          }`
        )
      }
      break
    case 'git':
      lines.push(
        [d.git.operation, d.git.branch, d.git.sha].filter(Boolean).join(' ')
      )
      break
    case 'task':
      lines.push(`${d.task.kind}: ${d.task.name}`)
      break
    case 'outcome':
      lines.push(
        [d.outcome.subject, d.outcome.reason].filter(Boolean).join(': ')
      )
      break
    default:
      break
  }
  return lines.join('\n')
}

/**
 * The accessible label for a row: what a screen reader announces (AH-179).
 *
 * Derived here rather than in the component because the label has to say the
 * same things the visual row does -- status, what happened, and the outcome --
 * and a label written next to the markup drifts from it the first time the markup
 * changes.
 */
export function accessibleLabel(event: ActivityEvent): string {
  const status =
    event.status === 'pending'
      ? 'in progress'
      : event.status === 'ok'
        ? 'succeeded'
        : event.status === 'error'
          ? 'failed'
          : 'cancelled'
  const parts = [event.title, status]
  const d = event.detail
  if (d.kind === 'command' && d.command.exitCode !== undefined) {
    parts.push(`exit code ${d.command.exitCode}`)
  }
  if (d.kind === 'verification') {
    const v = d.verification
    if (v.failed !== undefined) parts.push(`${v.failed} failed`)
    if (v.passed !== undefined) parts.push(`${v.passed} passed`)
  }
  if (d.kind === 'change' && (d.change.added !== undefined || d.change.removed !== undefined)) {
    parts.push(`${d.change.added ?? 0} lines added, ${d.change.removed ?? 0} removed`)
  }
  if (d.kind === 'permission' && d.permission.decision) {
    parts.push(`decision ${d.permission.decision.replace(/_/g, ' ')}`)
  }
  return parts.join(', ')
}
