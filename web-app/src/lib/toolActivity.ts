/**
 * The canonical record of what every tool call did. AH-050.
 *
 * One call is one item that moves through phases. It is never replaced by its
 * result and never removed: a timeline that drops a finished call cannot
 * answer "what did this run actually do", which is the question the record
 * exists for. Ordering comes from when a call was requested, so two calls that
 * finish out of order still read in the order they were made.
 *
 * Everything is written through `dispatchCoworkTool`, which is the single
 * place a tool call is routed -- the main agent, a subagent, a background
 * task and an MCP server all arrive there -- so nothing can execute without
 * appearing here.
 */
import { invoke } from '@tauri-apps/api/core'
import { summarizeToolInput } from '@/lib/toolInputSummary'

export type ToolActivityPhase =
  | 'requested'
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

export type ToolActivityEvent = {
  v: number
  at: string
  session: string
  run: string
  call: string
  invocation: string
  agent: string
  project: string
  tool: string
  capability: string
  kind: string
  resource: string
  summary: string
  phase: ToolActivityPhase
  elapsed_ms?: number | null
  exit_code?: number | null
  detail: string
}

export type ToolActivityItem = {
  call: string
  tool: string
  session: string
  run: string
  invocation: string
  agent: string
  resource: string
  summary: string
  phase: ToolActivityPhase
  requested_at: string
  elapsed_ms: number | null
  exit_code: number | null
  detail: string
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
  const fields = ['path', 'file_path', 'filePath', 'command', 'url', 'pattern']
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Identity the events of a run are written under. */
export type ToolActivityContext = {
  session: string
  run: string
  invocation?: string
  agent?: string
  project?: string
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
  const at = new Date().toISOString()
  const write = async () => {
    try {
      await invoke('tool_activity_record', {
        event: {
          v: 1,
          at,
          session: '',
          run: '',
          invocation: '',
          agent: '',
          project: '',
          capability: capabilityOf(event.tool),
          kind: kindOf(event.tool),
          resource: '',
          summary: '',
          detail: '',
          elapsed_ms: null,
          exit_code: null,
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
 * Run one tool call and record its whole life.
 *
 * Wraps the routing function rather than each tool, so a tool added later is
 * covered without being told to be. The outcome is passed through untouched --
 * recording must not change what the model is told happened.
 */
export async function withToolActivity<T extends { isError?: boolean }>(
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
    project: ctx.project ?? '',
    resource: resourceOf(call.input),
    summary: summarizeToolInput(call.input),
  }
  const startedAt = Date.now()

  // Not awaited: the queue keeps the order, and a tool must start when the
  // model asked for it rather than when its audit line reached disk.
  void recordToolActivity({ ...base, phase: 'requested' })
  void recordToolActivity({ ...base, phase: 'running' })

  try {
    const outcome = await route()
    // An aborted run reports its calls as cancelled, not failed: the user
    // stopping work is not the tool going wrong, and the timeline has to keep
    // the two apart.
    const phase: ToolActivityPhase = signal?.aborted
      ? 'cancelled'
      : outcome.isError
        ? 'failed'
        : 'succeeded'
    await recordToolActivity({
      ...base,
      phase,
      elapsed_ms: Date.now() - startedAt,
    })
    return outcome
  } catch (error) {
    // `dispatchCoworkTool` resolves rather than throws, so reaching here means
    // something unforeseen went wrong -- which is exactly the case the record
    // must not lose.
    await recordToolActivity({
      ...base,
      phase: signal?.aborted ? 'cancelled' : 'failed',
      elapsed_ms: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
