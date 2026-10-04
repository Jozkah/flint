/**
 * Background subagents of one Cowork run.
 *
 * `task` normally blocks until the child answers. With `background: true` the
 * child starts and the call returns a task id at once; the parent keeps
 * working and later collects the answer with `await_task`, polls with
 * `task_status`, or stops it with `cancel_task`. The runner still dispatches a
 * step's tool calls one at a time, so background is where the concurrency
 * comes from: start several, then await them.
 *
 * One registry per run. A run that is about to end waits for the children it
 * started (`settleAll`), the same way the Rust loop joins its backgrounded
 * subagents, and Stop reaches them through the subagent abort handles that
 * `dispatchChild` registers, so nothing here keeps its own cancellation state.
 *
 * The tool's answer is capped like a foreground one (`capSubagentOutput`); the
 * rest of a cut answer is read back with `await_task(task_id, offset)`.
 */
import type { ToolOutcome } from '@/lib/coworkRunner'

/** Characters of a cut answer returned per `await_task` read. */
export const RETAINED_WINDOW_CHARS = 14_000
/** Cut answers kept for later reads, per run. */
const MAX_RETAINED = 8
/** Characters kept of any one answer. */
const MAX_RETAINED_CHARS = 400_000

export type BackgroundState = 'running' | 'done' | 'failed' | 'cancelled'

export type BackgroundTaskInfo = {
  id: string
  name: string
  state: BackgroundState
  startedAt: number
  endedAt?: number
}

type Entry = BackgroundTaskInfo & {
  promise: Promise<ToolOutcome>
  outcome?: ToolOutcome
  cancel: () => boolean
  cancelled: boolean
}

export class BackgroundTasks {
  private readonly entries = new Map<string, Entry>()
  private readonly retained = new Map<string, string>()

  /** `headChars` is how much of a cut answer is shown before the cut. */
  constructor(private readonly headChars = 9_000) {}

  /**
   * Start `run` and return at once. `cancel` aborts it by the same handle the
   * Tasks panel's Stop uses; it returns false when there was nothing to stop.
   */
  start(
    id: string,
    name: string,
    run: () => Promise<ToolOutcome>,
    cancel: () => boolean,
    now: () => number = Date.now
  ): BackgroundTaskInfo {
    const entry: Entry = {
      id,
      name,
      state: 'running',
      startedAt: now(),
      cancel,
      cancelled: false,
      // Never rejects: a throw becomes a failed outcome the parent can read.
      promise: Promise.resolve(),
    } as unknown as Entry
    entry.promise = run().then(
      (outcome) => this.settle(entry, outcome, now),
      (error) =>
        this.settle(
          entry,
          {
            output: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          },
          now
        )
    )
    this.entries.set(id, entry)
    return this.info(entry)
  }

  /**
   * An outcome as the model should see it: when the child's answer was cut,
   * the full text is kept and a line says how to read the rest. `full` is
   * dropped, so it never travels with the outcome.
   */
  collect(id: string, outcome: ToolOutcome): ToolOutcome {
    if (!outcome.full) return outcome
    const { full, ...rest } = outcome
    this.retain(id, full)
    return { ...rest, output: rest.output + retrievalHint(id, this.headChars) }
  }

  private settle(
    entry: Entry,
    raw: ToolOutcome,
    now: () => number
  ): ToolOutcome {
    const outcome = this.collect(entry.id, raw)
    entry.outcome = outcome
    entry.endedAt = now()
    entry.state = entry.cancelled
      ? 'cancelled'
      : outcome.isError
        ? 'failed'
        : 'done'
    return outcome
  }

  private info(entry: Entry): BackgroundTaskInfo {
    const { id, name, state, startedAt, endedAt } = entry
    return { id, name, state, startedAt, ...(endedAt ? { endedAt } : {}) }
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Every task of the run, oldest first. */
  list(): BackgroundTaskInfo[] {
    return [...this.entries.values()].map((e) => this.info(e))
  }

  status(id: string): BackgroundTaskInfo | undefined {
    const entry = this.entries.get(id)
    return entry ? this.info(entry) : undefined
  }

  /** Wait for one task. `undefined` for an id this run never started. */
  async await(id: string, signal?: AbortSignal): Promise<ToolOutcome | undefined> {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (!signal) return entry.promise
    return new Promise<ToolOutcome>((resolve, reject) => {
      const stop = () => reject(signal.reason ?? new Error('aborted'))
      if (signal.aborted) return stop()
      signal.addEventListener('abort', stop, { once: true })
      entry.promise.then(
        (o) => {
          signal.removeEventListener('abort', stop)
          resolve(o)
        },
        (e) => {
          signal.removeEventListener('abort', stop)
          reject(e)
        }
      )
    })
  }

  /** Stop one task. Returns what happened, for the model to read. */
  cancel(id: string): 'cancelled' | 'finished' | 'unknown' {
    const entry = this.entries.get(id)
    if (!entry) return 'unknown'
    if (entry.state !== 'running') return 'finished'
    entry.cancelled = true
    return entry.cancel() ? 'cancelled' : 'finished'
  }

  /** Tasks still running. */
  running(): BackgroundTaskInfo[] {
    return this.list().filter((t) => t.state === 'running')
  }

  /** Wait for every task to settle, whatever became of it. */
  async settleAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.promise))
  }

  /** Keep the full text of a cut answer so `await_task` can read the rest. */
  retain(id: string, full: string): void {
    this.retained.delete(id)
    this.retained.set(id, full.slice(0, MAX_RETAINED_CHARS))
    while (this.retained.size > MAX_RETAINED) {
      const oldest = this.retained.keys().next().value
      if (oldest === undefined) break
      this.retained.delete(oldest)
    }
  }

  /** A window of a retained answer starting at `offset`. */
  readRetained(id: string, offset: number): string {
    const full = this.retained.get(id)
    if (full === undefined) {
      return `ERROR: no shortened answer is kept for '${id}'. Only answers that were cut are kept, and only the most recent ${MAX_RETAINED}.`
    }
    const chars = Array.from(full)
    if (offset >= chars.length) {
      return `ERROR: offset ${offset} is past the end of the answer (${chars.length} characters).`
    }
    const end = Math.min(chars.length, offset + RETAINED_WINDOW_CHARS)
    const window = chars.slice(offset, end).join('')
    return end < chars.length
      ? `${window}\n\n[... characters ${offset}-${end} of ${chars.length}. Call await_task with task_id=${id} and offset=${end} for the next part. ...]`
      : `${window}\n\n[... characters ${offset}-${end} of ${chars.length}: the end of the answer. ...]`
  }
}

/** An outcome without the whole-answer copy, for a caller that keeps none. */
export function omitFull(outcome: ToolOutcome): ToolOutcome {
  if (!outcome.full) return outcome
  const { full: _full, ...rest } = outcome
  void _full
  return rest
}

/** The line appended to a cut answer so the model knows how to read the rest. */
export function retrievalHint(id: string, headChars: number): string {
  return `\n\n(The full answer is kept: call await_task with task_id=${id} and offset=${headChars} to read the omitted part.)`
}

export const TASK_STATUS_TOOL_NAME = 'task_status'
export const AWAIT_TASK_TOOL_NAME = 'await_task'
export const CANCEL_TASK_TOOL_NAME = 'cancel_task'

/** The three tools that manage background tasks. */
export const BACKGROUND_TASK_TOOLS = new Set([
  TASK_STATUS_TOOL_NAME,
  AWAIT_TASK_TOOL_NAME,
  CANCEL_TASK_TOOL_NAME,
])

const ago = (ms: number) => `${Math.round(ms / 1000)}s`

/** `task_status`, for the model: one task, or every task of the run. */
export function renderTaskStatus(
  tasks: readonly BackgroundTaskInfo[],
  now: number
): string {
  if (tasks.length === 0) {
    return 'No background tasks have been started in this run.'
  }
  return tasks
    .map(
      (t) =>
        `- ${t.id} [${t.name}] ${t.state}, ${ago((t.endedAt ?? now) - t.startedAt)}`
    )
    .join('\n')
}

/**
 * Run a background tool call against a run's registry.
 *
 * Kept apart from the dispatcher so the three tools' contract is testable
 * without a run: the dispatcher passes the registry, the clock and the call's
 * signal, and hands back whatever this returns.
 */
export async function runBackgroundTool(
  tool: string,
  input: unknown,
  tasks: BackgroundTasks,
  opts: { now?: () => number; signal?: AbortSignal; headChars?: number } = {}
): Promise<ToolOutcome> {
  const raw = (input ?? {}) as Record<string, unknown>
  const id = typeof raw.task_id === 'string' ? raw.task_id.trim() : ''
  const now = (opts.now ?? Date.now)()
  const unknown = (): ToolOutcome => ({
    output: `ERROR: no background task '${id}' in this run. task_status lists them.`,
    isError: true,
  })

  if (tool === TASK_STATUS_TOOL_NAME) {
    if (!id) return { output: renderTaskStatus(tasks.list(), now) }
    const one = tasks.status(id)
    return one
      ? { output: renderTaskStatus([one], now) }
      : unknown()
  }
  if (!id) {
    return { output: `ERROR: ${tool} needs a \`task_id\`.`, isError: true }
  }
  if (tool === CANCEL_TASK_TOOL_NAME) {
    const result = tasks.cancel(id)
    if (result === 'unknown') return unknown()
    return {
      output:
        result === 'cancelled'
          ? `Cancelled ${id}; it was stopped and its partial work is discarded.`
          : `${id} had already finished, so nothing was cancelled. Collect its result with await_task.`,
    }
  }
  // await_task
  if (typeof raw.offset === 'number' && raw.offset >= 0) {
    const text = tasks.readRetained(id, Math.floor(raw.offset))
    return text.startsWith('ERROR') ? { output: text, isError: true } : { output: text }
  }
  const outcome = await tasks.await(id, opts.signal)
  if (!outcome) return unknown()
  return outcome
}
