/**
 * The canonical record of what every tool call did. AH-050.
 *
 * One call is one item that moves through phases. It is never replaced by its
 * result and never removed: a timeline that drops a finished call cannot
 * answer "what did this run actually do", which is the question the record
 * exists for. Ordering comes from the sequence the backend stamps on each
 * event as it writes it, so two calls that finish out of order still read in
 * the order they were made.
 *
 * Every tool call is written through `withToolActivity`: Cowork routes through
 * `dispatchCoworkTool` (the main agent, subagents, background tasks and MCP
 * servers all arrive there) and Chat through its tool loop in the thread
 * route. The run's own lifecycle -- a subagent dispatched or stopped, a
 * background job stopped, a context compaction -- is recorded into the same
 * sequence with `recordLifecycle`, so there is one execution-event model and
 * not several stores that can disagree.
 */
import { useUsageStats } from '@/stores/usage-stats-store'
import type { ChangeActorInput } from '@janhq/tauri-plugin-agent-tools-api'
import { invoke } from '@tauri-apps/api/core'
import { summarizeToolInput } from '@/lib/toolInputSummary'
import { backgroundJobId } from '@/lib/coworkTasks'
import { bashExitCode } from '@/lib/redact'

export type ToolActivityPhase =
  | 'requested'
  | 'queued'
  | 'awaiting-permission'
  | 'allowed'
  | 'refused'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'timed-out'

/** Phases that end a call. */
export const TERMINAL_PHASES: ReadonlySet<ToolActivityPhase> = new Set([
  'refused',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
  'timed-out',
])

/**
 * Whether "Hide completed tool activity" may hide this.
 *
 * Only a clean success. A refusal, a failure, a cancellation, a stale call and
 * one still running are all things someone needs to see, and hiding them would
 * make the setting a way to lose the very events worth reading.
 */
export function isHideablePhase(phase: ToolActivityPhase): boolean {
  return phase === 'succeeded'
}

/** What a call did to one file, counted from the diff that call produced. */
export type FileChange = {
  path: string
  /** `created` / `edited` / `deleted` / `renamed` / `binary`. */
  kind: string
  from?: string
  added?: number
  removed?: number
  /** The diff was stored and `loadToolDiff` returns it. */
  diffStored: boolean
  /** Larger than the backend keeps: counted, not stored. */
  oversized: boolean
}

export type EventType = 'tool' | 'lifecycle'

/** Which surface recorded an event. */
export type ActivitySource = 'cowork' | 'chat' | 'cli' | 'subagent'

export type ToolActivityEvent = {
  v: number
  at: string
  at_ms?: number | null
  seq?: number | null
  session: string
  run: string
  call: string
  invocation: string
  agent: string
  /** The agent's durable identity (AH-110): `agent`, `agent:<name>`, `role:<name>`. */
  agent_id?: string
  project: string
  source?: string
  parent?: string
  supersedes?: string
  event_type?: EventType
  lifecycle?: string
  tool: string
  capability: string
  kind: string
  resource: string
  summary: string
  input?: string | null
  phase: ToolActivityPhase
  elapsed_ms?: number | null
  exit_code?: number | null
  detail: string
  /** On a harness refusal: its kind (`tool-not-offered`, `invalid-call`). */
  refusal?: string | null
  output?: string | null
  output_truncated?: boolean
  job_id?: string
  task_id?: string
  change?: FileChange | null
  /** The call's diff; the backend stores it beside the log, never inline. */
  diff?: string | null
  /** What the call's command used (AH-174). */
  resources?: unknown
}

export type ToolActivityItem = {
  /** Session and call together: a provider call id alone is not unique. */
  id?: string
  call: string
  tool: string
  session: string
  run: string
  invocation: string
  agent: string
  /** The agent's durable identity, empty when the event carried none. */
  agent_id?: string
  source?: string
  parent?: string
  supersedes?: string
  event_type?: EventType
  lifecycle?: string
  resource: string
  summary: string
  input?: string | null
  phase: ToolActivityPhase
  seq?: number | null
  requested_at: string
  requested_at_ms?: number | null
  finished_at?: string | null
  finished_at_ms?: number | null
  elapsed_ms: number | null
  exit_code: number | null
  detail: string
  refusal?: string | null
  output?: string | null
  output_truncated?: boolean
  /** `available` / `truncated` / `unavailable` / `pending`. */
  output_state?: string
  job_id?: string
  task_id?: string
  change?: FileChange | null
  history: ToolActivityPhase[]
}

/** What a tool is allowed to do, for the audit's own classification. */
const CAPABILITIES: Record<string, string> = {
  read: 'read',
  ls: 'read',
  find: 'read',
  grep: 'read',
  screenshot: 'read',
  memory_list: 'read',
  memory_read: 'read',
  skill_list: 'read',
  skill_read: 'read',
  todo: 'read',
  ask: 'read',
  write: 'write',
  edit: 'write',
  memory_write: 'write',
  skill_write: 'write',
  bash: 'exec',
  task: 'exec',
  team: 'exec',
  web_search: 'net',
  web_fetch: 'net',
}

/** The shape of the thing acted on, which is what makes a resource canonical. */
const KINDS: Record<string, string> = {
  bash: 'command',
  task: 'process',
  team: 'process',
  todo: 'unknown',
  ask: 'unknown',
  web_search: 'net',
  web_fetch: 'net',
}

export function capabilityOf(tool: string): string {
  if (CAPABILITIES[tool]) return CAPABILITIES[tool]
  // An MCP tool is named `server__tool` and is not one of ours to classify by
  // name; it is reported as exec, which is the authority it actually carries.
  if (tool.includes('__')) return 'exec'
  return 'read'
}

export function kindOf(tool: string): string {
  if (KINDS[tool]) return KINDS[tool]
  if (tool.includes('__')) return 'mcp'
  if (CAPABILITIES[tool] === 'read' || CAPABILITIES[tool] === 'write') {
    return 'path'
  }
  return 'unknown'
}

/**
 * The one thing a call acted on, in a form two calls on the same file share.
 *
 * A path, a command or a URL -- whichever the tool's input carries. Anything
 * else is left empty rather than guessed at, so a resource in the record is
 * always a real one.
 */
export function resourceOf(input: unknown): string {
  const parsed =
    typeof input === 'string'
      ? (() => {
          try {
            return JSON.parse(input)
          } catch {
            return null
          }
        })()
      : input
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  const fields = [
    'path',
    'file_path',
    'filePath',
    'command',
    'url',
    'pattern',
    'query',
  ]
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Longest input sent for the record; the backend redacts and bounds again. */
const MAX_INPUT_CHARS = 4096

/** A call's arguments as text for the record, bounded. */
export function inputOf(input: unknown): string | undefined {
  if (input == null) return undefined
  let text: string
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    return undefined
  }
  return text.length > MAX_INPUT_CHARS
    ? `${text.slice(0, MAX_INPUT_CHARS)}…`
    : text
}

/** Identity the events of a run are written under. */
export type ToolActivityContext = {
  session: string
  run: string
  invocation?: string
  agent?: string
  /**
   * The agent's durable identity in the subject spelling (AH-110): `agent`,
   * `agent:<name>`, `role:<name>`. Absent means the primary agent, or -- for a
   * subagent -- derived from `agent`, which is why a renameable display name is
   * never the only identifier on a change.
   */
  agentId?: string
  /** The agent that dispatched this one, same spelling. */
  parentAgent?: string
  project?: string
  source?: ActivitySource
  /** The task or workflow this call runs under. */
  parent?: string
}

/** What a change should be attributed to, from the identity a call runs under. */
export function actorFor(
  ctx: Partial<ToolActivityContext> | undefined
): ChangeActorInput | undefined {
  if (!ctx) return undefined
  const name = ctx.agent?.trim()
  const id = ctx.agentId?.trim() || (name && name !== 'main' ? `agent:${name}` : 'agent')
  if (!id) return undefined
  return {
    id,
    label: name && name !== 'main' ? name : undefined,
    parent: ctx.parentAgent?.trim() || undefined,
    invocation: ctx.invocation || undefined,
    task: ctx.parent || undefined,
  }
}

/**
 * Tool outcomes and notable run events for the Overview dashboard, counted
 * locally. Only ends of calls count, so a retried call is one outcome.
 */
function noteForOverview(
  event: Partial<ToolActivityEvent> & Pick<ToolActivityEvent, 'tool' | 'phase'>,
  at: number
) {
  try {
    const stats = useUsageStats.getState()
    const isTool = !event.event_type || event.event_type === 'tool'
    if (isTool && event.phase === 'succeeded') stats.recordToolCall(true, at)
    if (isTool && (event.phase === 'failed' || event.phase === 'timed-out'))
      stats.recordToolCall(false, at)
    if (event.lifecycle === 'compaction' && event.phase === 'succeeded')
      stats.pushActivity({ kind: 'compaction', title: 'Context compacted', detail: event.summary || undefined, at })
    else if (isTool && event.phase === 'allowed')
      stats.pushActivity({ kind: 'tool-approved', title: 'Tool call approved', detail: event.summary || event.tool, at })
    else if (isTool && event.phase === 'refused')
      stats.pushActivity({ kind: 'tool-denied', title: 'Tool call refused', detail: event.summary || event.tool, at })
    else if (isTool && event.phase === 'failed')
      stats.pushActivity({ kind: 'tool-failed', title: 'Tool call failed', detail: event.summary || event.tool, at })
  } catch {
    // The dashboard is a convenience; it must never break recording.
  }
}

/**
 * Events are appended in the order they were reported, whoever reported them.
 *
 * Recording is not allowed to hold up the tool it is recording, so callers
 * report without waiting. That leaves ordering to this queue: without it two
 * concurrent calls could land their `running` after their `succeeded`, and the
 * fold would show a finished call as still in flight.
 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Record one event, best effort.
 *
 * A tool call must not fail because its audit line could not be written, and a
 * caller must not have to handle that: this never rejects. Outside Tauri --
 * unit tests, the browser dev server -- there is nowhere to write, and the
 * call is a no-op rather than an error.
 */
export function recordToolActivity(
  event: Partial<ToolActivityEvent> &
    Pick<ToolActivityEvent, 'call' | 'tool' | 'phase'>
): Promise<void> {
  // Stamped when the event happened, not when its turn in the queue comes up.
  const atMs = Date.now()
  noteForOverview(event, atMs)
  const at = new Date(atMs).toISOString()
  const write = async () => {
    try {
      await invoke('tool_activity_record', {
        event: {
          v: 2,
          at,
          at_ms: atMs,
          session: '',
          run: '',
          invocation: '',
          agent: '',
          agent_id: '',
          project: '',
          source: '',
          parent: '',
          supersedes: '',
          event_type: 'tool',
          lifecycle: '',
          capability: capabilityOf(event.tool),
          kind: kindOf(event.tool),
          resource: '',
          summary: '',
          detail: '',
          elapsed_ms: null,
          exit_code: null,
          job_id: '',
          task_id: '',
          ...event,
        },
      })
    } catch {
      // Reported, not thrown: see above.
    }
  }
  queue = queue.then(write, write)
  return queue as Promise<void>
}

/**
 * Record something the run itself did, into the same sequence as its tool
 * calls: a subagent dispatched, queued, finished or stopped; a background job
 * stopped; a context compaction. One item per `id`, moving through phases
 * like a tool call does.
 */
export function recordLifecycle(
  ctx: ToolActivityContext,
  event: {
    /** Stable for the life of the thing: the same id for every phase. */
    id: string
    /** `subagent`, `background-job`, `compaction`, `steering`, `approval`. */
    lifecycle: string
    phase: ToolActivityPhase
    summary?: string
    detail?: string
    jobId?: string
    taskId?: string
    elapsedMs?: number
  }
): Promise<void> {
  return recordToolActivity({
    call: event.id,
    tool: event.lifecycle,
    phase: event.phase,
    event_type: 'lifecycle',
    lifecycle: event.lifecycle,
    session: ctx.session,
    run: ctx.run,
    invocation: ctx.invocation ?? '',
    agent: ctx.agent ?? '',
    agent_id: actorFor(ctx)?.id ?? '',
    project: ctx.project ?? '',
    source: ctx.source ?? '',
    parent: ctx.parent ?? '',
    summary: event.summary ?? '',
    detail: event.detail ?? '',
    job_id: event.jobId ?? '',
    task_id: event.taskId ?? '',
    elapsed_ms: event.elapsedMs ?? null,
    capability: 'read',
    kind: 'process',
  })
}

/** The durable timeline for a session, rebuilt from the record on disk. */
export async function loadToolActivity(
  session?: string
): Promise<ToolActivityItem[]> {
  try {
    // A backend that answers with nothing is an empty timeline, not a broken
    // conversation: the transcript still renders without the record.
    const items = await invoke<ToolActivityItem[]>('tool_activity_items', {
      session: session ?? null,
    })
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

/**
 * The diff one call produced, as stored when it ended; `null` when none was.
 *
 * `invocation` picks the right call when a provider reused its id across
 * requests (#244); without one the backend reads the pre-invocation layout.
 */
export async function loadToolDiff(
  session: string,
  call: string,
  invocation?: string
): Promise<string | null> {
  try {
    const diff = await invoke<string | null>('tool_activity_diff', {
      session,
      call,
      invocation: invocation || null,
    })
    return typeof diff === 'string' ? diff : null
  } catch {
    return null
  }
}

/** One session's permission decisions and execution record, as JSON. AH-200. */
export async function exportAudit(session: string): Promise<string> {
  return await invoke<string>('audit_export', { session })
}

/**
 * The parts of a tool's outcome the record keeps, whichever surface ran it:
 * Cowork's `{output, isError, diff}`, Chat's `{content, error}` and an MCP
 * result all read the same.
 */
export type RecordableOutcome = {
  isError?: boolean
  output?: unknown
  content?: unknown
  error?: unknown
  diff?: string | null
  resources?: unknown
}

function outcomeText(outcome: RecordableOutcome): string | undefined {
  const pick = outcome.error ?? outcome.output ?? outcome.content
  if (pick == null) return undefined
  if (typeof pick === 'string') return pick
  try {
    return JSON.stringify(pick)
  } catch {
    return undefined
  }
}

/**
 * Run one tool call and record its whole life.
 *
 * Wraps the routing function rather than each tool, so a tool added later is
 * covered without being told to be. The outcome is passed through untouched --
 * recording must not change what the model is told happened.
 */
export async function withToolActivity<T extends RecordableOutcome>(
  call: { toolCallId: string; toolName: string; input: unknown },
  ctx: ToolActivityContext,
  signal: AbortSignal | undefined,
  route: () => Promise<T>
): Promise<T> {
  const base = {
    call: call.toolCallId,
    tool: call.toolName,
    session: ctx.session,
    run: ctx.run,
    invocation: ctx.invocation ?? '',
    agent: ctx.agent ?? '',
    agent_id: actorFor(ctx)?.id ?? '',
    project: ctx.project ?? '',
    source: ctx.source ?? '',
    parent: ctx.parent ?? '',
    resource: resourceOf(call.input),
    summary: summarizeToolInput(call.input),
  }
  const startedAt = Date.now()

  // Not awaited: the queue keeps the order, and a tool must start when the
  // model asked for it rather than when its audit line reached disk.
  void recordToolActivity({
    ...base,
    phase: 'requested',
    input: inputOf(call.input) ?? null,
  })
  void recordToolActivity({ ...base, phase: 'running' })

  // Exactly one terminal event per call. A stop that lands while the tool is
  // still out (a git push waiting on the network, a command the backend has
  // not returned from) settles the call as cancelled straight away: if the
  // tool never comes back -- the window reloads, the app exits -- the record
  // still ends, instead of staying `running` for good.
  let ended = false
  const end = async (event: Parameters<typeof recordToolActivity>[0]) => {
    if (ended) return
    ended = true
    await recordToolActivity(event)
  }
  const onAbort = () => {
    void end({
      ...base,
      phase: 'cancelled',
      elapsed_ms: Date.now() - startedAt,
      detail: 'stopped before the tool returned',
    })
  }
  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const outcome = await route()
    // An aborted run reports its calls as cancelled, not failed: the user
    // stopping work is not the tool going wrong, and the timeline has to keep
    // the two apart.
    const failed = outcome.isError || Boolean(outcome.error)
    const phase: ToolActivityPhase = signal?.aborted
      ? 'cancelled'
      : failed
        ? 'failed'
        : 'succeeded'
    const text = outcomeText(outcome)
    const jobId =
      call.toolName === 'bash' ? (backgroundJobId(text) ?? '') : ''
    await end({
      ...base,
      phase,
      elapsed_ms: Date.now() - startedAt,
      output: text ?? null,
      exit_code: call.toolName === 'bash' ? (bashExitCode(text) ?? null) : null,
      job_id: jobId,
      diff: outcome.diff ?? null,
      ...(outcome.resources ? { resources: outcome.resources } : {}),
    })
    return outcome
  } catch (error) {
    // The router resolves rather than throws, so reaching here means something
    // unforeseen went wrong -- which is exactly the case the record must not
    // lose.
    await end({
      ...base,
      phase: signal?.aborted ? 'cancelled' : 'failed',
      elapsed_ms: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
