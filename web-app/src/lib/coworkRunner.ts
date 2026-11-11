import { recordToolActivity, type ToolActivityContext } from '@/lib/toolActivity'
import type { UIMessage, UIMessageChunk } from 'ai'
import type { CoworkTurn, TurnMemory, Usage } from '@/types/coworkSession'
import {
  MAX_AGENT_STEPS,
  budgetExceeded,
  newSpend,
  recordSpend,
  creditCompaction,
  type BudgetStop,
} from '@/lib/coworkBudget'
import {
  detectLoop,
  loopFinalTurnNote,
  loopStopNotice,
  type ObservedCall,
} from '@/lib/runLoopGuard'
import {
  configuredOperationTimeoutMs,
  isExpired,
  operationSignal,
  type Deadline,
} from '@/lib/runDeadline'
import { decideRetry, waitFor } from '@/lib/runRetry'
import { WEB_TOOL_NAMES } from '@/lib/webSearchTool'
import { estimateHistoryTokens, isContextLengthError } from '@/lib/compaction'
import { withToolInputs } from '@/lib/coworkTurns'
import type { ToolImage } from '@/lib/toolOutputImages'
import { refusalKindOf } from '@/lib/cowork/run/runnerToolArgs'
import { handles, isAbortLike } from '@/lib/cowork/run/runHandles'
import { isUnfittableRequest } from '@/lib/cowork/run/unfittable'
import {
  StreamSink,
  untilStopped,
  consumeStep,
  assistantMessageFor,
  turnsFor,
} from '@/lib/cowork/run/runStepStream'

export {
  looksTruncatedArgs,
  refusalKindOf,
  schemaIssues,
} from '@/lib/cowork/run/runnerToolArgs'
export {
  abortAll,
  abortRun,
  abortSubagent,
  answerAsk,
  beginRun,
  endRun,
  ensureRun,
  getRunHandle,
  hasSubagent,
  isAbortLike,
  isRunning,
  registerSubagent,
  unregisterSubagent,
} from '@/lib/cowork/run/runHandles'
export type {
  RunHandle,
} from '@/lib/cowork/run/runHandles'
export {
  NO_ARG_TOOLS,
  assistantMessageFor,
  consumeStep,
  turnsFor,
  untilStopped,
} from '@/lib/cowork/run/runStepStream'
export type {
  StreamSink,
} from '@/lib/cowork/run/runStepStream'


/**
 * How much smaller a compacted history is, by the estimator compaction itself
 * uses, so the per-run allowance can be credited for the summarized part.
 */
function compactionSaving(before: UIMessage[], after: UIMessage[]): number {
  return Math.max(
    0,
    estimateHistoryTokens(before) - estimateHistoryTokens(after)
  )
}

/** A compaction that fails leaves the history as it was; a stop still stops. */
async function compactOrNull(
  deps: Pick<RunDeps, 'compact'>,
  messages: UIMessage[],
  why: 'threshold' | 'context-error',
  signal: AbortSignal,
  failure?: unknown,
  headroom?: number
): Promise<UIMessage[] | null> {
  try {
    const args: [UIMessage[], typeof why, AbortSignal, unknown?, number?] = [
      [...messages],
      why,
      signal,
    ]
    if (headroom !== undefined) args.push(failure, headroom)
    else if (failure !== undefined) args.push(failure)
    return (await deps.compact?.(...args)) ?? null
  } catch (error) {
    if (signal.aborted || isUnfittableRequest(error)) throw error
    console.warn('[cowork] compaction failed; continuing without it', error)
    return null
  }
}

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
 * The loop is also ours because the AI SDK cannot own it here: Flint's tools are
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

/** The message that carries harness hints (`ToolOutcome.note`) to the model. */
export function harnessNote(notes: string[]): string {
  return `Note from Flint (not typed by the user, and not part of any tool result or file): ${notes.join(' ')}`
}

export type ToolOutcome = {
  /** Sent to the model. */
  output: string
  isError?: boolean
  /** Display-only unified diff. Never reaches the model. */
  diff?: string
  /**
   * A harness hint for the model. Never part of `output`: it is sent as its
   * own labelled note after the step's tool results, so the model cannot
   * mistake it for what a file or command returned. Never displayed.
   */
  note?: string
  /**
   * Images the call returned for the model to see (`read` of an image file).
   * Reach the model as image parts, only when it can see; the text `output`
   * always accompanies them.
   */
  images?: ToolImage[]
  /** What the call's command used (AH-174). Never reaches the model. */
  resources?: unknown
  /**
   * Set when the harness declined the call rather than a tool failing, so a
   * caller branches on the kind instead of parsing `output`.
   */
  refusal?: HarnessRefusal
  /**
   * Set when the call's answer means this run must not take another step --
   * the opening turn's proposal was accepted, and the work belongs to a new
   * run with the session's own tools. The step's results are still recorded;
   * the model is simply not called again. Never reaches the model.
   */
  endsTurn?: boolean
  /**
   * The input the call actually ran with, when the user edited it before
   * allowing it. The transcript and the model's copy of the call show this,
   * not the model's original.
   */
  ranInput?: unknown
  /**
   * A subagent's whole answer when `output` is a shortened copy of it. Taken
   * by the dispatcher, which keeps it for `await_task` reads; never sent on.
   */
  full?: string
}

export type HarnessRefusalKind = 'tool-not-offered' | 'invalid-call'

export type HarnessRefusal = {
  kind: HarnessRefusalKind
  tool: string
  /** The agent that asked (`main`, or a role or custom agent's name). */
  agent?: string
}

// Re-exported so existing callers/tests of the old names keep working; the
// recovery itself lives in the one shared module.
export { recoverToolArgs } from '@/lib/toolCallRepair'
/** Backward-compatible alias for the old name; same conservative rules. */
export { recoverToolArgs as salvageToolArgs } from '@/lib/toolCallRepair'

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
  /** The provider's finish reason: `length` means the output cap cut it. */
  finishReason?: string
}

export type RunDeps = {
  /**
   * One model turn. Returns the raw UI message stream.
   *
   * `textOnly` asks for a turn in which the model may not call tools (the
   * tools stay advertised, so the prompt prefix is unchanged, but the tool
   * choice is `none`). Used for the one closing turn after the loop guard
   * stops a run.
   */
  sendStep: (
    messages: UIMessage[],
    signal: AbortSignal,
    opts?: {
      textOnly?: boolean
      /**
       * True when a length refusal of this step would be compacted and sent
       * again (`compact` is wired and the one length retry is unspent). The
       * transport's pre-flight check is lenient only then: with no retry
       * left, the provider's raw refusal would end the run instead of
       * Flint's own explanation.
       */
      lengthRecovery?: boolean
    }
  ) => Promise<ReadableStream<UIMessageChunk>>
  /**
   * The transport's strict pre-flight refusal of the step just sent, when it
   * went out only on the lenient check (see `lengthRecovery`); null or absent
   * otherwise. Asked when a length refusal leaves nothing to compact.
   */
  preflightRefusal?: () => Error | null
  /** Run one tool call. Must resolve, never reject. */
  dispatch: (call: PendingToolCall, signal: AbortSignal) => Promise<ToolOutcome>
  /**
   * Told, with the tool names in call order, once every call of a step has its
   * result and before the next model request. Observe-only: not awaited, and
   * a throw here never reaches the run.
   */
  onBatchFinished?: (toolNames: string[]) => void
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
  /**
   * Who this run records its calls as: session, run, agent, and the request
   * the current step answered. Read when a call is recorded here (a call the
   * runner refuses without dispatching), so the refusal lands in the right
   * session's record rather than in one with no session at all.
   */
  activity?: () => ToolActivityContext
  /** Monotonic ids for the assistant messages this run appends. */
  nextMessageId: () => string
  /**
   * Input the user typed while this run was working, handed over at a safe
   * boundary: before a model call, after every tool result of the previous
   * step, and when the model is about to hand back its answer. Returns the
   * messages taken, in the order they were typed; they are no longer pending
   * once returned. janhq/jan#8864.
   */
  takeSteering?: () => UIMessage[] | Promise<UIMessage[]>
  /** Check for pending steering between calls from one model response. */
  hasSteering?: () => boolean | Promise<boolean>
  /**
   * Compact the conversation when it needs it (`lib/compaction.ts`).
   *
   * Asked before every model call with `threshold`: the caller measures the
   * request and returns a compacted history, or null to send it as it is.
   * Asked once more with `context-error` when the provider refused a step for
   * its length, and the step is retried with the compacted history. Every tool
   * result of the previous step is in by then, so no call is parted from its
   * result.
   */
  compact?: (
    messages: UIMessage[],
    why: 'threshold' | 'context-error',
    signal: AbortSignal,
    /** The refusal that asked for this compaction, when it was one. */
    failure?: unknown,
    /**
     * Tokens the next step is expected to add, from the growth of recent
     * steps' prompts. Lets the caller compact before a large tool result
     * carries the request past the window rather than after.
     */
    headroom?: number
  ) => Promise<UIMessage[] | null>
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
/**
 * A shell result that reported success while a step inside it failed, as the
 * shell tool marks it. Counted as a failure by the loop guard, since the model
 * was told to treat it as one.
 */
export const maskedFailure = (output: unknown): boolean =>
  typeof output === 'string' && output.includes('[shell: reported exit 0, but')

type RunTurnOptions = {
  messages: UIMessage[]
  deps: RunDeps
  signal: AbortSignal
  maxSteps?: number
  /** Tokens already spent by this session, which the caps apply across. */
  sessionTokens?: number
  /**
   * Spend allowance for this request; defaults to `MAX_SESSION_TOKENS`. A run
   * that compacts automatically is given more (`sessionTokenLimitFor`), since
   * the allowance counts history that compaction folds away.
   */
  sessionTokenLimit?: number
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
  /**
   * Call ids this run has already used. Only the cross-step policy: when
   * given, an id repeated in a LATER step is refused; omitted (Cowork), ids
   * may recur across steps. An id repeated inside ONE step is always refused,
   * whether or not this is set (it would overwrite the first call's outcome).
   */
  seenCallIds?: Set<string>
}

/** What one run carries from step to step. */
type RunState = {
  messages: UIMessage[]
  /** Every tool call this run made, for the loop guard. AH-029/AH-030. */
  observed: ObservedCall[]
  step: number
  // Not a running sum of each step's `total_tokens`: every step replays the whole
  // conversation, so summing totals charges the same context once per step.
  spend: ReturnType<typeof newSpend>
  usage: Usage | null
  // Prompt growth of the last few steps, to tell compaction how much the next
  // one will probably add. `lastPromptSeen` is shrunk by each compaction.
  recentGrowth: number[]
  lastPromptSeen: number | undefined
  // One automatic recovery per run: a reply cut off by the output limit or a
  // dropped stream, or an empty reply, is continued once without the user
  // having to type "continue". Once, so it can never loop.
  autoContinued: boolean
  // Likewise for a step that stalled past its retries: resumed once.
  timeoutResumed: boolean
  // Calls the last step skipped because steering was pending; told to the model
  // when that steering turned out to have nothing to deliver.
  skippedForSteering: string[]
}

/** What the loop does after a stage: go round again, or end with an outcome. */
type StepTransition = { kind: 'continue' } | { kind: 'finish'; outcome: RunOutcome }

const CONTINUE: StepTransition = { kind: 'continue' }

function outcomeOf(
  st: RunState,
  stoppedBy: RunOutcome['stoppedBy'],
  errorText?: string
): RunOutcome {
  return {
    messages: st.messages,
    steps: st.step,
    usage: st.usage,
    sessionTokens: st.spend.spent,
    stoppedBy,
    ...(errorText !== undefined ? { errorText } : {}),
  }
}

const finish = (
  st: RunState,
  stoppedBy: RunOutcome['stoppedBy'],
  errorText?: string
): StepTransition => ({ kind: 'finish', outcome: outcomeOf(st, stoppedBy, errorText) })

function nudgeFor(deps: RunDeps, text: string): UIMessage {
  return {
    id: deps.nextMessageId(),
    role: 'user',
    parts: [{ type: 'text', text }],
  }
}

/** Stop, step/token caps and the deadline, checked before a step starts. */
function checkLimits(
  st: RunState,
  opts: RunTurnOptions,
  maxSteps: number,
  now: () => number
): RunOutcome | null {
  if (opts.signal.aborted) return outcomeOf(st, 'aborted')
  const overBudget = budgetExceeded(
    { step: st.step, sessionTokens: st.spend.spent },
    maxSteps,
    opts.sessionTokenLimit
  )
  if (overBudget) return outcomeOf(st, overBudget)
  // Checked before the step starts, not after it finishes: a run whose time
  // is up should not spend another model call discovering that.
  if (opts.deadline && isExpired(opts.deadline, now())) {
    return outcomeOf(st, 'deadline')
  }
  return null
}

/** Swap the history for its compacted form and credit what it saved. */
function applyCompaction(st: RunState, compacted: UIMessage[]): void {
  const saving = compactionSaving(st.messages, compacted)
  if (st.lastPromptSeen != null) {
    st.lastPromptSeen = Math.max(0, st.lastPromptSeen - saving)
  }
  st.spend = creditCompaction(st.spend, saving)
  st.messages.splice(0, st.messages.length, ...compacted)
}

/**
 * The safe boundary (janhq/jan#8864): every tool result of the last step is
 * in and no model call is under way, so input typed meanwhile reaches the
 * model now rather than after the run ends. Plain user messages, in the
 * order typed -- never folded into the model's own turn.
 */
async function deliverSteering(st: RunState, deps: RunDeps): Promise<void> {
  const steered = (await deps.takeSteering?.()) ?? []
  if (steered.length > 0) st.messages.push(...steered)
  else if (st.skippedForSteering.length > 0) {
    // The steering that cut the last batch short delivered nothing (mail a
    // tool had already consumed): say what was not run so it is re-issued.
    st.messages.push(
      nudgeFor(
        deps,
        `Not run; re-issue if still needed: ${st.skippedForSteering.join(', ')}. ` +
          'They were skipped for input that had already been handled.'
      )
    )
  }
  st.skippedForSteering = []
}

/**
 * Compacted here, at the same boundary: the next request would cross the
 * window's threshold, so the run keeps going on a summary instead of
 * stopping at the window.
 */
async function compactAtBoundary(
  st: RunState,
  deps: RunDeps,
  signal: AbortSignal
): Promise<void> {
  if (!deps.compact) return
  const headroom =
    st.recentGrowth.length > 0
      ? Math.ceil(Math.max(...st.recentGrowth) * 1.25)
      : undefined
  const compacted = await compactOrNull(
    deps,
    st.messages,
    'threshold',
    signal,
    undefined,
    headroom
  )
  if (compacted) applyCompaction(st, compacted)
}

/**
 * One step, retried only where retrying can help. AH-021/AH-024/AH-025.
 *
 * The timeout is chained to the run's own signal, so a stream that goes
 * quiet and a user who pressed Stop end the same way. A retry is a new
 * dispatch and gets its own invocation and snapshot, because it is a
 * different request that happens to carry the same messages.
 */
async function sendStepWithRetries(
  st: RunState,
  opts: RunTurnOptions,
  now: () => number
): Promise<{ ok: true; result: StepResult } | { ok: false; error: unknown; timedOut: boolean }> {
  const { deps, signal } = opts
  let attempt = 1
  let timedOut = false
  let lengthRetried = false
  try {
    while (true) {
      const operation = operationSignal(
        signal,
        opts.operationTimeoutMs ?? configuredOperationTimeoutMs()
      )
      try {
        // A snapshot, not the live array: the loop pushes to `messages` after the
        // stream is handed over, and the transport rewrites what it is given
        // (trimming, compaction) without expecting it to move underneath.
        // Not left to the transport to notice Stop: see `untilStopped`.
        const stream = await untilStopped(
          deps.sendStep(withToolInputs([...st.messages]), operation.signal, {
            lengthRecovery: !!deps.compact && !lengthRetried,
          }),
          operation.signal,
          (late) => void late.cancel().catch(() => {})
        )
        // The request was accepted: that is progress too.
        operation.touch()
        const result = await consumeStep(
          stream,
          deps.sink,
          operation.signal,
          operation.touch
        )
        return { ok: true, result }
      } catch (failure) {
        timedOut = operation.timedOut()
        // The provider refused the request for its length: compact once and
        // send again, rather than ending a run the window could still hold.
        if (
          deps.compact &&
          !lengthRetried &&
          !timedOut &&
          !signal.aborted &&
          isContextLengthError(failure)
        ) {
          lengthRetried = true
          const compacted = await compactOrNull(
            deps,
            st.messages,
            'context-error',
            signal,
            failure
          )
          if (compacted) {
            applyCompaction(st, compacted)
            continue
          }
          // Nothing to fold (the fixed prompt and tools are what is large).
          // A step the transport let through only on its lenient pre-flight
          // check ends on that check's explanation, with Flint's breakdown of
          // what is large; any other ends on the provider's refusal. Neither
          // sends again (not even the generic retry below): the same request
          // would be refused again.
          throw deps.preflightRefusal?.() ?? failure
        }
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
  } catch (error) {
    return { ok: false, error, timedOut }
  }
}

/** A step that could not be sent: resume once after a stall, else end the run. */
function stepFailed(
  st: RunState,
  deps: RunDeps,
  signal: AbortSignal,
  e: unknown,
  timedOut: boolean
): StepTransition {
  if (timedOut && !signal.aborted) {
    // The step already got its retries. Resume the run once rather than
    // ending it: the history is intact, so the model can pick up where it
    // stopped, as it would after an interrupted run. Once, so a model that
    // is really down still ends the run instead of looping.
    if (!st.timeoutResumed) {
      st.timeoutResumed = true
      st.messages.push(
        nudgeFor(
          deps,
          'Note from Flint (not typed by the user): the previous model request stalled and was restarted. Continue the task.'
        )
      )
      return CONTINUE
    }
    return finish(st, 'timeout', e instanceof Error ? e.message : String(e))
  }
  // A transport failure is an outcome, not an exception: throwing here left
  // the caller with no steps, no usage and nothing to render but the raw
  // message, and a user-initiated stop arrived down this same path.
  if (isAbortLike(e, signal)) {
    return { kind: 'finish', outcome: { ...outcomeOf(st, 'aborted'), errorText: undefined } }
  }
  return finish(st, 'error', e instanceof Error ? e.message : String(e))
}

/** Count the step's usage, and note how much the prompt grew. */
function recordStepUsage(st: RunState, result: StepResult): void {
  if (result.usage) {
    st.usage = result.usage
    st.spend = recordSpend(st.spend, result.usage)
    const prompt = result.usage.prompt_tokens
    if (prompt != null) {
      if (st.lastPromptSeen != null) {
        st.recentGrowth.push(Math.max(0, prompt - st.lastPromptSeen))
        if (st.recentGrowth.length > 5) st.recentGrowth.shift()
      }
      st.lastPromptSeen = prompt
    }
  }
}

/** A step whose stream reported an error: continue a cut-off reply once, else stop. */
function streamErrored(
  st: RunState,
  deps: RunDeps,
  signal: AbortSignal,
  result: StepResult & { errorText: string }
): StepTransition {
  // Only when the step produced something: an assistant message with no
  // parts is a turn the model never took, and it would be replayed as one.
  if (result.text || result.toolCalls.length > 0) {
    st.messages.push(
      assistantMessageFor(deps.nextMessageId(), result, new Map())
    )
  }
  // A text reply cut off mid-stream: keep what arrived and ask for the
  // rest, once, rather than ending the run on half an answer.
  if (
    !st.autoContinued &&
    !signal.aborted &&
    !result.aborted &&
    result.text.trim() &&
    result.toolCalls.length === 0
  ) {
    st.autoContinued = true
    deps.onStep({ step: st.step, result, turns: turnsFor(result, new Map()), outcomes: new Map() })
    st.messages.push(
      nudgeFor(
        deps,
        'Your previous reply was interrupted before it finished. Continue exactly where it stopped, without repeating what you already wrote.'
      )
    )
    return CONTINUE
  }
  deps.onStep({
    step: st.step,
    result,
    turns: turnsFor(result, new Map()),
    outcomes: new Map(),
  })
  return finish(st, 'error', result.errorText)
}

/** First id that repeats within `calls` or was already in `seen`, if any. */
export function firstDuplicateCallId(
  calls: PendingToolCall[],
  seen?: ReadonlySet<string>
): string | undefined {
  const inStep = new Set<string>()
  for (const { toolCallId } of calls) {
    if (inStep.has(toolCallId) || seen?.has(toolCallId)) return toolCallId
    inStep.add(toolCallId)
  }
  return undefined
}

/**
 * Validate the whole step before any side effect. Outcomes are keyed by call
 * id, so a repeated id would let the second call's result overwrite the
 * first's (which may already have written). A malformed step fails closed:
 * nothing is dispatched and its calls are not committed, so no phantom result
 * stands for a call that never ran.
 */
function refuseDuplicateCallIds(
  st: RunState,
  deps: RunDeps,
  result: StepResult,
  seen?: ReadonlySet<string>
): RunOutcome | null {
  const duplicateId = firstDuplicateCallId(result.toolCalls, seen)
  if (duplicateId === undefined) return null
  const errorText = `Duplicate tool call id: ${duplicateId}. The step was refused and none of its tool calls ran.`
  const refused: StepResult = { ...result, toolCalls: [], errorText }
  if (refused.text) {
    st.messages.push(assistantMessageFor(deps.nextMessageId(), refused, new Map()))
  }
  deps.onStep({
    step: st.step,
    result: refused,
    turns: turnsFor(refused, new Map()),
    outcomes: new Map(),
  })
  return outcomeOf(st, 'error', errorText)
}

/**
 * Run the step's tool calls. Tools run one at a time: they share a
 * workspace, and the progress attribution in the UI assumes a single call in
 * flight.
 */
async function runToolCalls(
  st: RunState,
  deps: RunDeps,
  signal: AbortSignal,
  result: StepResult
): Promise<{ outcomes: Map<string, ToolOutcome>; steeringPending: boolean }> {
  const outcomes = new Map<string, ToolOutcome>()
  let steeringPending = false
  /**
   * Yield to steering between calls. The rest of the batch is skipped, and
   * recorded as skipped so the timeline shows every call the model asked for.
   */
  const yieldToSteering = async (index: number) => {
    if (
      !deps.hasSteering ||
      [...outcomes.values()].some((one) => one.endsTurn) ||
      !(await deps.hasSteering())
    ) {
      return false
    }
    steeringPending = true
    const who = deps.activity?.()
    for (const skipped of result.toolCalls.slice(index + 1)) {
      outcomes.set(skipped.toolCallId, {
        output:
          'Not run because the user steered this turn before this call started. ' +
          'Re-issue it if it is still needed.',
        isError: true,
      })
      st.skippedForSteering.push(skipped.toolName)
      const identity = {
        call: skipped.toolCallId,
        tool: skipped.toolName,
        session: who?.session ?? '',
        run: who?.run ?? '',
        invocation: who?.invocation ?? '',
        agent: who?.agent ?? '',
        project: who?.project ?? '',
        source: who?.source ?? '',
        parent: who?.parent ?? '',
      }
      void recordToolActivity({ ...identity, phase: 'requested' })
      void recordToolActivity({
        ...identity,
        phase: 'cancelled',
        detail: 'skipped: the user steered this turn before it started',
      })
    }
    return true
  }
  for (const [index, call] of result.toolCalls.entries()) {
    if (signal.aborted) {
      outcomes.set(call.toolCallId, {
        output: '(interrupted)',
        isError: true,
      })
      continue
    }
    if (call.invalid !== undefined) {
      const who = deps.activity?.()
      const refusal: HarnessRefusal = {
        kind: refusalKindOf(call.invalid),
        tool: call.toolName,
        ...(who?.agent ? { agent: who.agent } : {}),
      }
      const outcome: ToolOutcome = {
        output:
          refusal.kind === 'tool-not-offered' &&
          WEB_TOOL_NAMES.has(call.toolName)
          ? // Named, so the model stops asking for it: it knows
            // `web_fetch` from training and kept retrying it.
            `\`${call.toolName}\` is not available: web access is turned ` +
            'off in Settings. Work from the local files, or tell the user ' +
            'that web search has to be turned on for this.'
          : `The call to \`${call.toolName}\` was not run: ${call.invalid} ` +
            'Use one of the tools you were given, with the arguments its ' +
            'schema describes. It did not run and produced no result: retry ' +
            'it, or tell the user it failed. Never report an outcome for it.',
        isError: true,
        refusal,
      }
      outcomes.set(call.toolCallId, outcome)
      // On the durable timeline as a refusal, the same as any other call the
      // run did not carry out, so the record says it was asked for -- in
      // this run's session, under this agent, with the refusal's kind.
      const identity = {
        call: call.toolCallId,
        tool: call.toolName,
        session: who?.session ?? '',
        run: who?.run ?? '',
        invocation: who?.invocation ?? '',
        agent: who?.agent ?? '',
        project: who?.project ?? '',
        source: who?.source ?? '',
        parent: who?.parent ?? '',
      }
      void recordToolActivity({ ...identity, phase: 'requested' })
      void recordToolActivity({
        ...identity,
        phase: 'refused',
        detail: `not a valid call: ${call.invalid}`.slice(0, 500),
        refusal: refusal.kind,
      })
      st.observed.push({
        tool: call.toolName,
        input: call.input,
        failed: true,
        error: outcome.output,
        path: pathOf(call.input),
        after: undefined,
      })
      if (await yieldToSteering(index)) break
      continue
    }
    const outcome = await deps.dispatch(call, signal)
    outcomes.set(call.toolCallId, outcome)
    st.observed.push({
      tool: call.toolName,
      input: call.input,
      // Settled either way: a success leaves `isError` unset, and the guard
      // reads `undefined` as "not known", which would let failures on
      // either side of a success count as a streak.
      failed: outcome.isError === true || maskedFailure(outcome.output),
      error:
        outcome.isError || maskedFailure(outcome.output)
          ? outcome.output
          : undefined,
      path: pathOf(call.input),
      after: outcome.diff,
      result:
        typeof outcome.output === 'string' ? outcome.output : undefined,
    })
    if (await yieldToSteering(index)) break
  }
  return { outcomes, steeringPending }
}

/**
 * Stop a run that has stopped getting anywhere. AH-029/AH-030.
 *
 * Counted from what happened rather than asked of the model: a model in a
 * loop is the one most likely to insist it is about to finish, so the
 * guard is not something it can waive.
 */
async function guardLoop(
  st: RunState,
  deps: RunDeps,
  signal: AbortSignal,
  result: StepResult,
  outcomes: Map<string, ToolOutcome>,
  steeringPending: boolean
): Promise<RunOutcome | null> {
  const loop = detectLoop(st.observed)
  if (!loop.tripped || steeringPending) return null
  // The guard's note rides on the last call's result, where the model
  // reads it on its closing turn, rather than as a message the user did
  // not write.
  const last = result.toolCalls[result.toolCalls.length - 1]
  const lastOutcome = last ? outcomes.get(last.toolCallId) : undefined
  if (last && lastOutcome) {
    outcomes.set(last.toolCallId, {
      ...lastOutcome,
      output: `${lastOutcome.output}\n\n${loopFinalTurnNote(loop)}`,
    })
  }
  if (result.text || result.toolCalls.length > 0) {
    st.messages.push(
      assistantMessageFor(deps.nextMessageId(), result, outcomes)
    )
  }
  deps.onStep({ step: st.step, result, turns: turnsFor(result, outcomes), outcomes })
  st.step = await closingTurn(st.messages, deps, signal, st.step, (u) => {
    st.usage = u
    st.spend = recordSpend(st.spend, u)
  })
  return outcomeOf(st, 'loop', loopStopNotice(loop))
}

/** Harness hints go after the tool results, labelled, never inside one. */
function appendHarnessNotes(
  st: RunState,
  deps: RunDeps,
  result: StepResult,
  outcomes: Map<string, ToolOutcome>
): void {
  const notes = [...outcomes.values()].flatMap((one) => (one.note ? [one.note] : []))
  if (result.toolCalls.length > 0 && notes.length > 0) {
    st.messages.push(nudgeFor(deps, harnessNote(notes)))
  }
}

/** Record the step, then decide: another step, or the end of the run. */
async function afterStep(
  st: RunState,
  deps: RunDeps,
  signal: AbortSignal,
  result: StepResult,
  outcomes: Map<string, ToolOutcome>
): Promise<StepTransition> {
  if (result.text || result.toolCalls.length > 0) {
    st.messages.push(assistantMessageFor(deps.nextMessageId(), result, outcomes))
  }
  deps.onStep({ step: st.step, result, turns: turnsFor(result, outcomes), outcomes })

  if (result.aborted || signal.aborted) return finish(st, 'aborted')
  // A call whose answer hands the work to a new run: finished, not stopped.
  if ([...outcomes.values()].some((one) => one.endsTurn)) return finish(st, 'done')
  appendHarnessNotes(st, deps, result, outcomes)
  // Tool calls mean the model asked for more work.
  if (result.toolCalls.length > 0) return CONTINUE
  // No tool calls means the model answered rather than asked for more work.
  // Input that arrived while that answer was written continues this run:
  // the answer is already in the history, the input follows it, and the
  // model replies to both. The caps are checked again at the top.
  const late = (await deps.takeSteering?.()) ?? []
  if (late.length > 0) {
    st.messages.push(...late)
    return CONTINUE
  }
  if (!st.autoContinued && result.finishReason === 'length' && result.text.trim()) {
    st.autoContinued = true
    st.messages.push(
      nudgeFor(
        deps,
        'Your previous reply was cut off by the output limit. Continue exactly where it stopped, without repeating what you already wrote.'
      )
    )
    return CONTINUE
  }
  if (!st.autoContinued && !result.text.trim()) {
    st.autoContinued = true
    st.messages.push(
      nudgeFor(
        deps,
        'Your last reply had no text and no tool call. Answer the request, or call a tool to continue the work.'
      )
    )
    return CONTINUE
  }
  return finish(st, 'done')
}

export async function runTurn(opts: RunTurnOptions): Promise<RunOutcome> {
  const { deps, signal } = opts
  const maxSteps = opts.maxSteps ?? MAX_AGENT_STEPS
  const now = opts.now ?? Date.now
  const st: RunState = {
    messages: [...opts.messages],
    observed: [],
    step: 0,
    spend: newSpend(opts.sessionTokens ?? 0),
    usage: null,
    recentGrowth: [],
    lastPromptSeen: undefined,
    autoContinued: false,
    timeoutResumed: false,
    skippedForSteering: [],
  }

  for (;;) {
    const stopped = checkLimits(st, opts, maxSteps, now)
    if (stopped) return stopped
    await deliverSteering(st, deps)
    await compactAtBoundary(st, deps, signal)

    const sent = await sendStepWithRetries(st, opts, now)
    if (!sent.ok) {
      const t = stepFailed(st, deps, signal, sent.error, sent.timedOut)
      if (t.kind === 'finish') return t.outcome
      continue
    }
    const result = sent.result
    st.step += 1
    deps.onResponse?.()
    recordStepUsage(st, result)

    if (result.errorText) {
      const t = streamErrored(st, deps, signal, result as StepResult & { errorText: string })
      if (t.kind === 'finish') return t.outcome
      continue
    }

    const duplicate = refuseDuplicateCallIds(st, deps, result, opts.seenCallIds)
    if (duplicate) return duplicate
    for (const call of result.toolCalls) opts.seenCallIds?.add(call.toolCallId)

    const { outcomes, steeringPending } = await runToolCalls(st, deps, signal, result)
    if (result.toolCalls.length > 0 && !signal.aborted) {
      try {
        deps.onBatchFinished?.(result.toolCalls.map((c) => c.toolName))
      } catch {
        // Observing a batch must never end a run.
      }
    }

    const looped = await guardLoop(st, deps, signal, result, outcomes, steeringPending)
    if (looped) return looped

    const t = await afterStep(st, deps, signal, result, outcomes)
    if (t.kind === 'finish') return t.outcome
  }
}

/**
 * One text-only turn after the loop guard stopped a run, so the model tells
 * the user what it tried and what is in the way instead of the run ending
 * with no message. Tool calls it makes anyway are dropped, never run. A
 * failure here is swallowed: the run is already stopping, and the guard's
 * own message still reaches the user.
 */
async function closingTurn(
  messages: UIMessage[],
  deps: RunDeps,
  signal: AbortSignal,
  step: number,
  onUsage: (usage: Usage) => void
): Promise<number> {
  if (signal.aborted) return step
  try {
    const stream = await untilStopped(
      deps.sendStep(withToolInputs([...messages]), signal, { textOnly: true }),
      signal,
      (late) => void late.cancel().catch(() => {})
    )
    const raw = await consumeStep(stream, deps.sink, signal)
    const result: StepResult = { ...raw, toolCalls: [] }
    const next = step + 1
    deps.onResponse?.()
    if (result.usage) onUsage(result.usage)
    if (result.text.trim()) {
      messages.push(assistantMessageFor(deps.nextMessageId(), result, new Map()))
    }
    deps.onStep({
      step: next,
      result,
      turns: turnsFor(result, new Map()),
      outcomes: new Map(),
    })
    return next
  } catch {
    return step
  }
}

export const __testing = { handles, checkLimits, stepFailed, afterStep }
