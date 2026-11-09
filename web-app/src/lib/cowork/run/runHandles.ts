// The Cowork runs in flight, by session: their abort handles, their
// subagents, and answering a question a run asked.

import type { AskAnswer } from '@/types/coworkSession'

export type RunHandle = {
  runId: string
  outer: AbortController
  tools: AbortController
  subagents: Map<string, AbortController>
  pendingAsks: Map<string, (answers: AskAnswer[] | null) => void>
}

export const handles = new Map<string, RunHandle>()

export function getRunHandle(sid: string): RunHandle | undefined {
  return handles.get(sid)
}

export function isRunning(sid: string): boolean {
  return handles.has(sid)
}

/**
 * Register a run so its children can be cancelled individually.
 *
 * The caller owns the outer controller — it is the one the route already
 * passes to `runTurn` and aborts from the stop button — and hands it over here
 * so `abortRun` reaches the same stream the route started. Without this the
 * handle map held nothing and every cancellation path was a no-op.
 */
export function beginRun(
  sid: string,
  runId: string,
  outer: AbortController
): RunHandle {
  const handle: RunHandle = {
    runId,
    outer,
    tools: new AbortController(),
    subagents: new Map(),
    pendingAsks: new Map(),
  }
  handles.set(sid, handle)
  return handle
}

/**
 * Make sure `sid` has a run handle, creating one only when there is none.
 *
 * Cowork begins a run per turn. A surface with no such turn (plain chat, a
 * Room) still needs somewhere for a child's own cancellation to live, or
 * `registerSubagent` hands back a controller that is already aborted and every
 * child it starts is cancelled before it begins. Unlike `beginRun` this never
 * replaces a handle that is already there.
 */
export function ensureRun(sid: string, runId: string, outer: AbortController): void {
  if (handles.has(sid)) return
  beginRun(sid, runId, outer)
}

/** Forget a run once it is over, without aborting anything. */
export function endRun(sid: string, runId?: string): void {
  const handle = handles.get(sid)
  // Guarded by run id: a turn that finishes after the next one has already
  // started must not unregister the run now in flight.
  if (!handle || (runId != null && handle.runId !== runId)) return
  handles.delete(sid)
}

/**
 * Give one dispatched subagent its own cancellation, chained to the run's.
 *
 * Returns the controller to pass as that child's signal. Registering it is what
 * makes a single child cancellable: without it every child shared the run's
 * controller, so the only way to stop one was to stop the whole run.
 *
 * `taskId` is the dispatching tool call id — the same id the activity record
 * uses — so a cancel request from the UI finds the right controller.
 */
export function registerSubagent(sid: string, taskId: string): AbortController {
  const controller = new AbortController()
  const handle = handles.get(sid)
  if (!handle) {
    // The run is already gone: hand back a controller that is already aborted
    // rather than one that will never fire, so the caller does not start work
    // nothing can stop.
    controller.abort('cancelled')
    return controller
  }
  handle.subagents.set(taskId, controller)
  return controller
}

/** Forget a child's controller once it has finished. */
export function unregisterSubagent(sid: string, taskId: string): void {
  handles.get(sid)?.subagents.delete(taskId)
}

/**
 * Is there still a controller for this child?
 *
 * What makes an agent task genuinely cancellable. A surface that offers to
 * stop work the run can no longer reach can only report failure, so it asks
 * this first rather than assuming.
 */
export function hasSubagent(sid: string, taskId: string): boolean {
  return handles.get(sid)?.subagents.has(taskId) ?? false
}

/**
 * Stop one dispatched subagent, leaving the rest of the run going.
 *
 * Returns false when there is nothing to stop — the child already finished, or
 * the run is over — so a caller can report that rather than claim a cancel it
 * did not perform.
 */
export function abortSubagent(
  sid: string,
  taskId: string,
  reason = 'cancelled'
): boolean {
  const controller = handles.get(sid)?.subagents.get(taskId)
  if (!controller) return false
  controller.abort(reason)
  handles.get(sid)?.subagents.delete(taskId)
  return true
}

/**
 * Stop a session's run: the model stream, the tool dispatch loop, every nested
 * subagent, and any question the user was being asked.
 *
 * A `bash` call already in flight is not stopped here — `execute_tool` is a
 * plain `invoke` with no cancellation token — so its result is discarded and
 * the process runs to completion. A command that has been *backgrounded* does
 * have a job id, and is killed through `bash_job_kill` by the activity layer,
 * which is the only place that knows which job belongs to which task.
 */
export function abortRun(sid: string, reason = 'cancelled'): void {
  const handle = handles.get(sid)
  if (!handle) return
  handle.outer.abort(reason)
  handle.tools.abort(reason)
  for (const child of handle.subagents.values()) child.abort(reason)
  handle.subagents.clear()
  // Reject rather than hang: an unanswered ask would otherwise keep its
  // promise, and the dispatch loop awaiting it, alive forever.
  for (const resolve of handle.pendingAsks.values()) resolve(null)
  handle.pendingAsks.clear()
  handles.delete(sid)
}

/**
 * Abort every running session, not just one.
 *
 * "Stop all activity" must reach the renderer-side run loops the same way
 * `abortRun` does — the Rust emergency-stop only sweeps subprocess Tokens and
 * never touches these JS `AbortController`s, so without this the model stream,
 * tool loop and subagents keep going after the user asked for everything to
 * stop. Returns how many sessions were aborted.
 */
export function abortAll(reason = 'cancelled'): number {
  const sids = [...handles.keys()]
  for (const sid of sids) abortRun(sid, reason)
  return sids.length
}

/**
 * Whether a rejection means "the user stopped this", not "this failed".
 *
 * Needed because the abort does not arrive as an `AbortError`: Flint streams
 * through the provider transport, whose `fetch` rejects with a plain
 * `Error('Request cancelled')` when the signal fires. Matched exactly rather
 * than by substring — "connection aborted" is a network failure and must keep
 * being reported as one.
 */
export function isAbortLike(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (e instanceof Error && e.name === 'AbortError') return true
  const message = (e instanceof Error ? e.message : String(e)).trim()
  return /^(request cancelled|the operation was aborted\.?|the user aborted a request\.?)$/i.test(
    message
  )
}

/** Settle a pending `ask`. Returns false when the request is already gone. */
export function answerAsk(
  sid: string,
  requestId: string,
  answers: AskAnswer[] | null
): boolean {
  const handle = handles.get(sid)
  const resolve = handle?.pendingAsks.get(requestId)
  if (!handle || !resolve) return false
  handle.pendingAsks.delete(requestId)
  resolve(answers)
  return true
}
