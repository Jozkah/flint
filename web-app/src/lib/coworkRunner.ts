/* eslint-disable @typescript-eslint/no-explicit-any */
import { recordToolActivity } from '@/lib/toolActivity'
import type { UIMessage, UIMessageChunk } from 'ai'
import type {
  AskAnswer,
  CoworkTurn,
  TurnMemory,
  Usage,
} from '@/types/coworkSession'
import {
  MAX_AGENT_STEPS,
  budgetExceeded,
  newSpend,
  recordSpend,
  type BudgetStop,
} from '@/lib/coworkBudget'
import {
  detectLoop,
  loopStopMessage,
  type ObservedCall,
} from '@/lib/runLoopGuard'
import { isExpired, operationSignal, type Deadline } from '@/lib/runDeadline'
import { decideRetry, waitFor } from '@/lib/runRetry'
import { readTokenUsage, toCoworkUsage } from '@/lib/tokenUsage'

/**
 * The HTTP status a failure carried, when it carried one.
 *
 * Providers surface it in different places -- a `status` field, a `cause`, or
 * only in the message -- and the difference between a 429 and a 401 decides
 * whether retrying is sensible or is re-sending the same rejection.
 */
function statusOf(failure: unknown): number | null {
  if (!failure || typeof failure !== 'object') return null
  const record = failure as Record<string, unknown>
  for (const key of ['status', 'statusCode']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  if (record.cause) return statusOf(record.cause)
  const match = /\b(4\d{2}|5\d{2})\b/.exec(
    failure instanceof Error ? failure.message : ''
  )
  return match ? Number(match[1]) : null
}

/** `Retry-After`, when the endpoint named its own delay. */
function retryAfterOf(failure: unknown): string | null {
  if (!failure || typeof failure !== 'object') return null
  const record = failure as Record<string, unknown>
  const headers = record.headers as
    | { get?: (name: string) => string | null }
    | undefined
  const header = headers?.get?.('retry-after')
  if (header) return header
  const direct = record.retryAfter
  if (typeof direct === 'string') return direct
  return record.cause ? retryAfterOf(record.cause) : null
}

/** The path a tool call acted on, for the no-progress check. */
function pathOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * The Cowork agent loop.
 *
 * Deliberately not `useChat`: that binds one Chat per session through React, and
 * a Cowork run has to survive with no component mounted so a background session
 * keeps streaming while another is viewed. The handle map below lives outside
 * React for the same reason — route unmount must not abort a run.
 *
 * The loop is also ours because the AI SDK cannot own it here: Jan's tools are
 * declared without an `execute`, so `streamText` returns after one step and
 * `stopWhen` never evaluates. Every step boundary, and every cap, is explicit.
 */

/** A tool call the model made, awaiting dispatch. */
export type PendingToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
  /**
   * Set when the SDK rejected the call before it could run -- an unknown tool,
   * or input that failed the tool's schema. Such a call is never dispatched;
   * the reason goes back to the model as the call's error result.
   */
  invalid?: string
}

export type ToolOutcome = {
  /** Sent to the model. */
  output: string
  isError?: boolean
  /** Display-only unified diff. Never reaches the model. */
  diff?: string
}

/** One model turn's worth of stream, folded into a shape the loop can act on. */
export type StepResult = {
  /**
   * Memory ids the request carried and withheld, as the transport reported
   * them. Absent when the transport retrieved nothing.
   */
  memory?: TurnMemory
  text: string
  toolCalls: PendingToolCall[]
  usage: Usage | null
  errorText?: string
  aborted: boolean
}

export type RunHandle = {
  runId: string
  outer: AbortController
  tools: AbortController
  subagents: Map<string, AbortController>
  pendingAsks: Map<string, (answers: AskAnswer[] | null) => void>
}

const handles = new Map<string, RunHandle>()

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
 * Whether a rejection means "the user stopped this", not "this failed".
 *
 * Needed because the abort does not arrive as an `AbortError`: Jan streams
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

// The cache counts ride along: dropping them here was where a provider's
// cache report used to stop on its way to the Cowork counter.
const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const memoryOf = (meta: unknown): TurnMemory | undefined => {
  const m = (meta as { memory?: unknown } | undefined)?.memory
  if (!m || typeof m !== 'object') return undefined
  const r = m as Record<string, unknown>
  const issues = idList(r.storageIssues)
  const off = idList(r.recallOff)
  const recall = Array.isArray(r.recall)
    ? r.recall.flatMap((x) => {
        const v = x as Record<string, unknown>
        return typeof v?.id === 'string' && typeof v.reason === 'string'
          ? [{ id: v.id, rank: typeof v.rank === 'number' ? v.rank : 0, reason: v.reason }]
          : []
      })
    : []
  return {
    injectedIds: idList(r.injectedIds),
    conflictIds: idList(r.conflictIds),
    ...(issues.length > 0 ? { storageIssues: issues } : {}),
    ...(off.length > 0 ? { recallOff: off } : {}),
    ...(recall.length > 0 ? { recall } : {}),
    ...(Array.isArray(r.overridden) && r.overridden.length > 0
      ? { overridden: r.overridden as NonNullable<TurnMemory['overridden']> }
      : {}),
    ...(Array.isArray(r.refused) && r.refused.length > 0
      ? { refused: r.refused as NonNullable<TurnMemory['refused']> }
      : {}),
  }
}

const usageOf = (meta: unknown): Usage | null => {
  const usage = readTokenUsage(
    (meta as { usage?: unknown } | undefined)?.usage
  )
  return usage ? toCoworkUsage(usage) : null
}

export type StreamSink = {
  onText: (delta: string) => void
  onToolStart: (toolCallId: string, toolName: string) => void
  onToolArgsDelta: (toolCallId: string, delta: string) => void
  onToolCall: (call: PendingToolCall) => void
}

function stopReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(String(signal.reason ?? 'aborted'), 'AbortError')
}

/**
 * `work`, or a rejection the moment `signal` fires, whichever comes first.
 * janhq/jan#8905.
 *
 * Stop has to end a run at once, whatever the run is waiting on. The transport
 * is handed the signal too, but does not always act on it -- a request still
 * waiting for its response to start, a stream it does not close -- and a run
 * that waited for it stayed running long after Stop. Whatever `work` produces
 * after that is handed to `release`, so it is not left open.
 */
export function untilStopped<T>(
  work: Promise<T>,
  signal: AbortSignal,
  release?: (late: T) => void
): Promise<T> {
  const settleLate = () =>
    work.then(
      (late) => release?.(late),
      () => {}
    )
  if (signal.aborted) {
    settleLate()
    return Promise.reject(stopReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      settleLate()
      reject(stopReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Fold one `sendMessages` stream into a `StepResult`, reporting progress as it
 * goes. Reading to completion is what makes tool dispatch safe: results land on
 * a finished assistant message, never interleaved with one still streaming.
 */
export async function consumeStep(
  stream: ReadableStream<UIMessageChunk>,
  sink: StreamSink,
  signal?: AbortSignal
): Promise<StepResult> {
  const reader = stream.getReader()
  const result: StepResult = {
    text: '',
    toolCalls: [],
    usage: null,
    aborted: false,
  }
  try {
    for (;;) {
      // The read watches the signal itself. Leaving it to the transport to
      // close the stream on abort meant a stream it did not close -- a
      // provider still streaming -- kept the run going after Stop.
      const { done, value } = await (signal
        ? untilStopped(reader.read(), signal)
        : reader.read())
      if (done) break
      const chunk = value as any
      switch (chunk.type) {
        case 'text-delta':
          result.text += chunk.delta
          sink.onText(chunk.delta)
          break
        case 'tool-input-start':
          sink.onToolStart(chunk.toolCallId, chunk.toolName)
          break
        case 'tool-input-delta':
          sink.onToolArgsDelta(chunk.toolCallId, chunk.inputTextDelta)
          break
        case 'tool-input-available': {
          const call: PendingToolCall = {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
          }
          result.toolCalls.push(call)
          sink.onToolCall(call)
          break
        }
        // The model asked for a tool it was not offered, or with input its
        // schema rejects. Kept as a call that failed, not dropped: dropping it
        // left the step with no tool calls, so the loop read it as a finished
        // answer -- the run ended with nothing done, nothing recorded and
        // nothing said, and the model never learned its call was refused.
        case 'tool-input-error': {
          // Arguments that are not JSON arrive as their raw text. That text
          // must not become the call's input: the history replays it to the
          // model, and a tool call whose input is a string rather than an
          // object broke every later request in the session. The text goes in
          // the refusal instead, so the model still sees what it sent.
          const raw = chunk.input
          const usable =
            raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          const call: PendingToolCall = {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: usable ? raw : {},
            invalid:
              String(chunk.errorText ?? 'the call was not valid') +
              (usable || raw === undefined
                ? ''
                : ` (the arguments sent were: ${
                    typeof raw === 'string' ? raw : JSON.stringify(raw)
                  })`),
          }
          result.toolCalls.push(call)
          sink.onToolCall(call)
          break
        }
        case 'error':
          result.errorText = chunk.errorText
          break
        case 'abort':
          result.aborted = true
          break
        case 'finish':
          result.usage = usageOf(chunk.messageMetadata) ?? result.usage
          result.memory = memoryOf(chunk.messageMetadata) ?? result.memory
          // A reply the provider never finished -- the connection dropped
          // mid-stream -- still ends with a `finish` chunk, carrying whatever
          // text arrived. Read as an answer, a child cut off after one word
          // was reported as a completed task. See `streamCutOff`.
          if (chunk.messageMetadata?.streamCutOff && !result.errorText) {
            result.errorText =
              "the model's reply ended before it finished: the stream was cut off"
          }
          break
        default:
          break
      }
    }
  } catch (e) {
    // Stopped mid-read: cancel the stream so the request underneath is
    // released rather than left streaming into nothing.
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => {})
    throw e
  } finally {
    reader.releaseLock()
  }
  return result
}

/** Assemble the assistant message for a completed step, results included. */
export function assistantMessageFor(
  id: string,
  step: StepResult,
  outcomes: Map<string, ToolOutcome>
): UIMessage {
  const parts: any[] = []
  if (step.text) parts.push({ type: 'text', text: step.text })
  for (const call of step.toolCalls) {
    const outcome = outcomes.get(call.toolCallId)
    const part: any = {
      type: `tool-${call.toolName}`,
      toolCallId: call.toolCallId,
      input: call.input,
      state: outcome
        ? outcome.isError
          ? 'output-error'
          : 'output-available'
        : 'input-available',
    }
    if (outcome) {
      if (outcome.isError) part.errorText = outcome.output
      else part.output = outcome.output
    }
    parts.push(part)
  }
  return { id, role: 'assistant', parts } as UIMessage
}

/** Transcript rows for a completed step, for the Cowork run store. */
export function turnsFor(
  step: StepResult,
  outcomes: Map<string, ToolOutcome>
): CoworkTurn[] {
  const turns: CoworkTurn[] = []
  // The request's own usage and memory ride on the turn it produced, so an
  // earlier turn's breakdown -- and which memories it carried -- can be shown
  // for that turn rather than only the session's latest.
  if (step.text) {
    turns.push({
      role: 'assistant',
      content: step.text,
      ...(step.usage ? { usage: step.usage } : {}),
      ...(step.memory ? { memory: step.memory } : {}),
    })
  }
  for (const call of step.toolCalls) {
    const outcome = outcomes.get(call.toolCallId)
    turns.push({
      role: 'tool',
      content: '',
      callId: call.toolCallId,
      name: call.toolName,
      args: call.input,
      result: outcome?.output ?? '',
      isError: outcome?.isError,
      diff: outcome?.diff,
      status: outcome ? 'done' : 'running',
    })
  }
  return turns
}

export type RunDeps = {
  /** One model turn. Returns the raw UI message stream. */
  sendStep: (
    messages: UIMessage[],
    signal: AbortSignal
  ) => Promise<ReadableStream<UIMessageChunk>>
  /** Run one tool call. Must resolve, never reject. */
  dispatch: (call: PendingToolCall, signal: AbortSignal) => Promise<ToolOutcome>
  sink: StreamSink
  /** Called once per completed step with everything that step produced. */
  onStep: (info: {
    step: number
    result: StepResult
    turns: CoworkTurn[]
    outcomes: Map<string, ToolOutcome>
  }) => void
  /**
   * Called once a step's model response has been read, before any of its tool
   * calls run. The one moment the request that produced the step's calls is
   * still the latest the caller has seen: a subagent dispatched by one of
   * those calls sends requests of its own.
   */
  onResponse?: () => void
  /** Monotonic ids for the assistant messages this run appends. */
  nextMessageId: () => string
  /**
   * Input the user typed while this run was working, handed over at a safe
   * boundary: before a model call, after every tool result of the previous
   * step, and when the model is about to hand back its answer. Returns the
   * messages taken, in the order they were typed; they are no longer pending
   * once returned. janhq/jan#8864.
   */
  takeSteering?: () => UIMessage[]
}

export type RunOutcome = {
  messages: UIMessage[]
  steps: number
  usage: Usage | null
  sessionTokens: number
  /** One reason, chosen by `terminalReason` when more than one was true. */
  stoppedBy: BudgetStop | 'error' | 'aborted' | 'done' | 'deadline' | 'timeout' | 'loop'
  errorText?: string
}

/**
 * Drive one user request to completion.
 *
 * Continues while the last step asked for tools, which is the only signal that
 * more work is pending. Stops cleanly on a cap rather than throwing: hitting the
 * step budget is routine on a long task, and the caller offers "Keep going".
 */
export async function runTurn(opts: {
  messages: UIMessage[]
  deps: RunDeps
  signal: AbortSignal
  maxSteps?: number
  /** Tokens already spent by this session, which the caps apply across. */
  sessionTokens?: number
  /**
   * When this run must be over. AH-019.
   *
   * Absolute, so it means the same thing after a restart as before one. Absent
   * leaves the run bounded only by steps and tokens, which is what a run
   * started before deadlines existed had.
   */
  deadline?: Deadline | null
  /** One model stream's limit. AH-021. */
  operationTimeoutMs?: number
  /** The clock, so the caps are testable without waiting for them. */
  now?: () => number
}): Promise<RunOutcome> {
  const { deps, signal } = opts
  const maxSteps = opts.maxSteps ?? MAX_AGENT_STEPS
  const now = opts.now ?? Date.now
  const messages = [...opts.messages]
  /** Every tool call this run made, for the loop guard. AH-029/AH-030. */
  const observed: ObservedCall[] = []
  let step = 0
  // Not a running sum of each step's `total_tokens`: every step replays the whole
  // conversation, so summing totals charges the same context once per step.
  let spend = newSpend(opts.sessionTokens ?? 0)
  let usage: Usage | null = null

  for (;;) {
    if (signal.aborted) {
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'aborted',
      }
    }
    const overBudget = budgetExceeded(
      { step, sessionTokens: spend.spent },
      maxSteps
    )
    if (overBudget) {
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: overBudget,
      }
    }

    // Checked before the step starts, not after it finishes: a run whose time
    // is up should not spend another model call discovering that.
    if (opts.deadline && isExpired(opts.deadline, now())) {
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'deadline',
      }
    }

    // The safe boundary (janhq/jan#8864): every tool result of the last step is
    // in and no model call is under way, so input typed meanwhile reaches the
    // model now rather than after the run ends. Plain user messages, in the
    // order typed -- never folded into the model's own turn.
    const steered = deps.takeSteering?.() ?? []
    if (steered.length > 0) messages.push(...steered)

    // A snapshot, not the live array: the loop pushes to `messages` after the
    // stream is handed over, and the transport rewrites what it is given
    // (trimming, compaction) without expecting it to move underneath.
    let result: StepResult
    let attempt = 1
    let timedOut = false
    try {
      /**
       * One step, retried only where retrying can help. AH-021/AH-024/AH-025.
       *
       * The timeout is chained to the run's own signal, so a stream that goes
       * quiet and a user who pressed Stop end the same way. A retry is a new
       * dispatch and gets its own invocation and snapshot, because it is a
       * different request that happens to carry the same messages.
       */
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const operation = operationSignal(signal, opts.operationTimeoutMs)
        try {
          // Not left to the transport to notice Stop: see `untilStopped`.
          const stream = await untilStopped(

            deps.sendStep([...messages], operation.signal),

            operation.signal,

            (late) => void late.cancel().catch(() => {})

          )
          result = await consumeStep(stream, deps.sink, operation.signal)
          break
        } catch (failure) {
          timedOut = operation.timedOut()
          const decision = decideRetry({
            facts: {
              status: statusOf(failure),
              retryAfter: retryAfterOf(failure),
              message: failure instanceof Error ? failure.message : String(failure),
              // A timeout is transient by definition; a user's stop is not.
              aborted: signal.aborted,
            },
            attempt,
            now: now(),
          })
          if (!decision.retry) throw failure
          // A wait that was cut short is a stop, not a completed backoff.
          if (!(await waitFor(decision.delayMs, signal))) throw failure
          attempt = decision.attempt
        } finally {
          operation.dispose()
        }
      }
    } catch (e) {
      if (timedOut && !signal.aborted) {
        return {
          messages,
          steps: step,
          usage,
          sessionTokens: spend.spent,
          stoppedBy: 'timeout',
          errorText: e instanceof Error ? e.message : String(e),
        }
      }
      // A transport failure is an outcome, not an exception: throwing here left
      // the caller with no steps, no usage and nothing to render but the raw
      // message, and a user-initiated stop arrived down this same path.
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: isAbortLike(e, signal) ? 'aborted' : 'error',
        errorText: isAbortLike(e, signal)
          ? undefined
          : e instanceof Error
            ? e.message
            : String(e),
      }
    }
    step += 1
    deps.onResponse?.()
    if (result.usage) {
      usage = result.usage
      spend = recordSpend(spend, result.usage)
    }

    if (result.errorText) {
      // Only when the step produced something: an assistant message with no
      // parts is a turn the model never took, and it would be replayed as one.
      if (result.text || result.toolCalls.length > 0) {
        messages.push(
          assistantMessageFor(deps.nextMessageId(), result, new Map())
        )
      }
      deps.onStep({
        step,
        result,
        turns: turnsFor(result, new Map()),
        outcomes: new Map(),
      })
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'error',
        errorText: result.errorText,
      }
    }

    // Tools run one at a time: they share a workspace, and the progress
    // attribution in the UI assumes a single call in flight.
    const outcomes = new Map<string, ToolOutcome>()
    for (const call of result.toolCalls) {
      if (signal.aborted) {
        outcomes.set(call.toolCallId, {
          output: '(interrupted)',
          isError: true,
        })
        continue
      }
      if (call.invalid !== undefined) {
        const outcome: ToolOutcome = {
          output:
            `The call to \`${call.toolName}\` was not run: ${call.invalid} ` +
            'Use one of the tools you were given, with the arguments its ' +
            'schema describes.',
          isError: true,
        }
        outcomes.set(call.toolCallId, outcome)
        // On the durable timeline as a refusal, the same as any other call the
        // run did not carry out, so the record says it was asked for.
        void recordToolActivity({
          call: call.toolCallId,
          tool: call.toolName,
          phase: 'requested',
        })
        void recordToolActivity({
          call: call.toolCallId,
          tool: call.toolName,
          phase: 'refused',
          detail: 'not a valid call',
        })
        observed.push({
          tool: call.toolName,
          input: call.input,
          failed: true,
          error: outcome.output,
          path: pathOf(call.input),
          after: undefined,
        })
        continue
      }
      const outcome = await deps.dispatch(call, signal)
      outcomes.set(call.toolCallId, outcome)
      observed.push({
        tool: call.toolName,
        input: call.input,
        failed: outcome.isError,
        error: outcome.isError ? outcome.output : undefined,
        path: pathOf(call.input),
        after: outcome.diff,
      })
    }

    /**
     * Stop a run that has stopped getting anywhere. AH-029/AH-030.
     *
     * Counted from what happened rather than asked of the model: a model in a
     * loop is the one most likely to insist it is about to finish, so the
     * guard is not something it can waive.
     */
    const loop = detectLoop(observed)
    if (loop.tripped) {
      if (result.text || result.toolCalls.length > 0) {
        messages.push(
          assistantMessageFor(deps.nextMessageId(), result, outcomes)
        )
      }
      deps.onStep({ step, result, turns: turnsFor(result, outcomes), outcomes })
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'loop',
        errorText: loopStopMessage(loop),
      }
    }

    if (result.text || result.toolCalls.length > 0) {
      messages.push(assistantMessageFor(deps.nextMessageId(), result, outcomes))
    }
    deps.onStep({ step, result, turns: turnsFor(result, outcomes), outcomes })

    if (result.aborted || signal.aborted) {
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'aborted',
      }
    }
    // No tool calls means the model answered rather than asked for more work.
    if (result.toolCalls.length === 0) {
      // Input that arrived while that answer was written continues this run:
      // the answer is already in the history, the input follows it, and the
      // model replies to both. The caps are checked again at the top.
      const late = deps.takeSteering?.() ?? []
      if (late.length > 0) {
        messages.push(...late)
        continue
      }
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'done',
      }
    }
  }
}

export const __testing = { handles }
