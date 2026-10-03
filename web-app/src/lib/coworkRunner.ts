/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  recordToolActivity,
  type ToolActivityContext,
} from '@/lib/toolActivity'
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
  creditCompaction,
  type BudgetStop,
} from '@/lib/coworkBudget'
import {
  detectLoop,
  loopFinalTurnNote,
  loopStopNotice,
  type ObservedCall,
} from '@/lib/runLoopGuard'
import { isExpired, operationSignal, type Deadline } from '@/lib/runDeadline'
import { decideRetry, waitFor } from '@/lib/runRetry'
import { WEB_TOOL_NAMES } from '@/lib/webSearchTool'
import { readTokenUsage, toCoworkUsage } from '@/lib/tokenUsage'
import { estimateHistoryTokens, isContextLengthError } from '@/lib/compaction'

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
  failure?: unknown
): Promise<UIMessage[] | null> {
  try {
    return (await deps.compact?.([...messages], why, signal, failure)) ?? null
  } catch (error) {
    if (signal.aborted) throw error
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

export type ToolOutcome = {
  /** Sent to the model. */
  output: string
  isError?: boolean
  /** Display-only unified diff. Never reaches the model. */
  diff?: string
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
   * A subagent's whole answer when `output` is a shortened copy of it. Taken
   * by the dispatcher, which keeps it for `await_task` reads; never sent on.
   */
  full?: string
}

/**
 * Why the harness declined a call without running anything.
 *
 * - `tool-not-offered`: the agent asked for a tool it was never given -- for a
 *   role, a tool outside its allowlist. Authority is not widened by asking.
 * - `invalid-call`: the call named an offered tool but its arguments could not
 *   be used.
 */
/**
 * Built-in tools whose schema has no properties: any arguments mean `{}`.
 * `skill_list` is not here: it takes an optional `query`, so its arguments are
 * kept (an empty or unparseable call is still recovered as `{}` below).
 */
export const NO_ARG_TOOLS: ReadonlySet<string> = new Set([
  'memory_list',
  'list_sessions',
  'message_check',
])

export type HarnessRefusalKind = 'tool-not-offered' | 'invalid-call'

export type HarnessRefusal = {
  kind: HarnessRefusalKind
  tool: string
  /** The agent that asked (`main`, or a role or custom agent's name). */
  agent?: string
}

import { recoverToolArgs, firstJsonObject } from '@/lib/toolCallRepair'
import { withToolInputs } from '@/lib/coworkTurns'

// Re-exported so existing callers/tests of the old names keep working; the
// recovery itself lives in the one shared module.
export { recoverToolArgs } from '@/lib/toolCallRepair'
/** Backward-compatible alias for the old name; same conservative rules. */
export { recoverToolArgs as salvageToolArgs } from '@/lib/toolCallRepair'

/** Cap on how much of a rejected call's raw arguments is echoed back. A whole
 * file's worth of `content` would otherwise flood the transcript and the next
 * request's context. */
const ARGS_ECHO_CAP = 300

/** Echo a rejected call's arguments, capped so a huge value is not dumped. */
function capArgs(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return s.length > ARGS_ECHO_CAP
    ? `${s.slice(0, ARGS_ECHO_CAP)}... (${s.length} chars, truncated)`
    : s
}

/**
 * Roughly, whether a string is JSON that was cut off before it closed -- a tool
 * call whose arguments ran past the model's output-token budget mid-value (a
 * `write` of a whole large file is the usual cause). Long, opens like JSON, and
 * has no complete top-level object, so it never balanced.
 */
export function looksTruncatedArgs(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const t = raw.trimStart()
  if (t.length < 200) return false
  if (!t.startsWith('{') && !t.startsWith('[')) return false
  return firstJsonObject(t) === undefined
}

/**
 * The refusal text for a call the SDK could not parse. A call cut off by the
 * output limit gets specific, actionable guidance -- resending the same giant
 * value just truncates again and loops -- rather than the generic parse error,
 * which the model cannot act on.
 */
/**
 * The one-line shape of a valid call to each built-in tool, for a refusal
 * that should show what was expected (transcript audit #12). Required
 * arguments only; the schema the model was given has the rest.
 */
const EXPECTED_SHAPES: Record<string, string> = {
  read: '{"path": "<file>"}',
  write: '{"path": "<file>", "content": "<text>"}',
  edit: '{"path": "<file>", "edits": [{"old_string": "<exact text>", "new_string": "<replacement>"}]}',
  ls: '{"path": "<folder>"}',
  find: '{"pattern": "<glob>"}',
  grep: '{"pattern": "<regex>"}',
  bash: '{"command": "<command>"}',
  git: '{"args": ["status"]} or {"program": "gh", "args": ["pr", "list", "--repo", "owner/repo"]}',
  request_access: '{"path": "<absolute folder>", "reason": "<why>", "access_mode": "read"}',
}

/**
 * The fields a schema validation error names, as "`path`: Required". The AI
 * SDK reports them as a JSON list of issues inside its message.
 */
export function schemaIssues(errorText: string): string[] {
  const out: string[] = []
  const issue =
    /\{[^{}]*?"path"\s*:\s*\[([^\]]*)\][^{}]*?"message"\s*:\s*"([^"]*)"[^{}]*?\}/g
  for (const m of errorText.matchAll(issue)) {
    const field = m[1]
      .split(',')
      .map((p) => p.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
      .join('.')
    out.push(`\`${field || '(arguments)'}\`: ${m[2]}`)
  }
  const missing = /missing required (?:argument|property) '?"?([\w.]+)/gi
  for (const m of errorText.matchAll(missing)) {
    const line = `\`${m[1]}\`: Required`
    if (!out.includes(line)) out.push(line)
  }
  return out
}

function explainInvalid(base: string, tool: string | undefined, raw: unknown): string {
  const issues = schemaIssues(base)
  const shape = tool ? EXPECTED_SHAPES[tool] : undefined
  const sent =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw as Record<string, unknown>)
      : []
  return (
    (issues.length ? ` Invalid or missing: ${issues.join('; ')}.` : '') +
    (shape ? ` Expected call shape: ${shape}.` : '') +
    (shape && sent.length
      ? ` You sent: ${sent.map((k) => `\`${k}\``).join(', ')}.`
      : '')
  )
}

function invalidArgsMessage(
  errorText: unknown,
  raw: unknown,
  usable: boolean,
  tool?: string
): string {
  const base = String(errorText ?? 'the call was not valid')
  if (looksTruncatedArgs(raw)) {
    return (
      `${base} -- the arguments were cut off before they were complete, which ` +
      'happens when the content is too large to return in one turn. Do not ' +
      'resend the whole thing: create the file with a first `write` of its ' +
      'opening portion, then extend it with `edit` in further calls (or write ' +
      'fewer lines per call).'
    )
  }
  return (
    base +
    (usable || raw === undefined
      ? ''
      : ` (the arguments sent were: ${capArgs(raw)})`) +
    explainInvalid(base, tool, raw)
  )
}

/** The kind of refusal an invalid call is, from the SDK's own reason. */
export function refusalKindOf(invalid: string): HarnessRefusalKind {
  return /unavailable tool|no such tool|not (?:a|an) (?:available|offered) tool/i.test(invalid)
    ? 'tool-not-offered'
    : 'invalid-call'
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
  /** The provider's finish reason: `length` means the output cap cut it. */
  finishReason?: string
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
          // Only the parse-failure case is recoverable: the arguments arrived as
          // raw text (a string) the SDK could not parse, but the model appended
          // a stray brace or trailing text after valid JSON (e.g. `{"path":"…"}}`).
          // Salvage the first complete object and dispatch it as a normal call.
          // An object that already reached the SDK failed for another reason --
          // an unavailable tool, a schema violation -- and is refused below.
          // A call to an offered tool that arrived with no arguments at all
          // (`null`, nothing, or an empty string) is a call with an empty
          // object: the model meant `ls {}` or `skill_list {}`. Refusing it
          // cost a turn and taught the model nothing. A tool that needs
          // arguments still says which one is missing when it runs.
          const empty =
            raw === null ||
            raw === undefined ||
            (typeof raw === 'string' && /^\s*(null)?\s*$/.test(raw))
          const offered =
            refusalKindOf(String(chunk.errorText ?? '')) !== 'tool-not-offered'
          // A tool that takes no arguments has nothing to get wrong: local
          // models send `[]`, `"list"` or a stray template fragment for
          // `memory_list`, and refusing that cost a turn every time.
          const salvaged =
            (empty || NO_ARG_TOOLS.has(chunk.toolName)) && offered
              ? {}
              : typeof raw === 'string'
                ? recoverToolArgs(raw)
                : undefined
          if (salvaged) {
            const call: PendingToolCall = {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: salvaged,
            }
            result.toolCalls.push(call)
            sink.onToolCall(call)
            break
          }
          const call: PendingToolCall = {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: usable ? raw : {},
            invalid: invalidArgsMessage(
              chunk.errorText,
              raw,
              usable,
              chunk.toolName
            ),
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
          {
            const reason = (chunk.messageMetadata as { finishReason?: unknown } | undefined)
              ?.finishReason
            if (typeof reason === 'string') result.finishReason = reason
          }
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
    opts?: { textOnly?: boolean }
  ) => Promise<ReadableStream<UIMessageChunk>>
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
    failure?: unknown
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
  // One automatic recovery per run: a reply cut off by the output limit or a
  // dropped stream, or an empty reply, is continued once without the user
  // having to type "continue". Once, so it can never loop.
  let autoContinued = false
  // Calls the last step skipped because steering was pending; told to the model
  // when that steering turned out to have nothing to deliver.
  let skippedForSteering: string[] = []
  const nudge = (text: string): UIMessage => ({
    id: deps.nextMessageId(),
    role: 'user',
    parts: [{ type: 'text', text }],
  })

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
    const steered = (await deps.takeSteering?.()) ?? []
    if (steered.length > 0) messages.push(...steered)
    else if (skippedForSteering.length > 0) {
      // The steering that cut the last batch short delivered nothing (mail a
      // tool had already consumed): say what was not run so it is re-issued.
      messages.push(
        nudge(
          `Not run; re-issue if still needed: ${skippedForSteering.join(', ')}. ` +
            'They were skipped for input that had already been handled.'
        )
      )
    }
    skippedForSteering = []

    // Compacted here, at the same boundary: the next request would cross the
    // window's threshold, so the run keeps going on a summary instead of
    // stopping at the window.
    if (deps.compact) {
      const compacted = await compactOrNull(deps, messages, 'threshold', signal)
      if (compacted) {
        spend = creditCompaction(spend, compactionSaving(messages, compacted))
        messages.splice(0, messages.length, ...compacted)
      }
    }

    // A snapshot, not the live array: the loop pushes to `messages` after the
    // stream is handed over, and the transport rewrites what it is given
    // (trimming, compaction) without expecting it to move underneath.
    let result: StepResult
    let attempt = 1
    let timedOut = false
    let lengthRetried = false
    try {
      /**
       * One step, retried only where retrying can help. AH-021/AH-024/AH-025.
       *
       * The timeout is chained to the run's own signal, so a stream that goes
       * quiet and a user who pressed Stop end the same way. A retry is a new
       * dispatch and gets its own invocation and snapshot, because it is a
       * different request that happens to carry the same messages.
       */
      while (true) {
        const operation = operationSignal(signal, opts.operationTimeoutMs)
        try {
          // Not left to the transport to notice Stop: see `untilStopped`.
          const stream = await untilStopped(

            deps.sendStep(withToolInputs([...messages]), operation.signal),

            operation.signal,

            (late) => void late.cancel().catch(() => {})

          )
          result = await consumeStep(stream, deps.sink, operation.signal)
          break
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
              messages,
              'context-error',
              signal,
              failure
            )
            if (compacted) {
              spend = creditCompaction(
                spend,
                compactionSaving(messages, compacted)
              )
              messages.splice(0, messages.length, ...compacted)
              continue
            }
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
      // A text reply cut off mid-stream: keep what arrived and ask for the
      // rest, once, rather than ending the run on half an answer.
      if (
        !autoContinued &&
        !signal.aborted &&
        !result.aborted &&
        result.text.trim() &&
        result.toolCalls.length === 0
      ) {
        autoContinued = true
        deps.onStep({ step, result, turns: turnsFor(result, new Map()), outcomes: new Map() })
        messages.push(
          nudge(
            'Your previous reply was interrupted before it finished. Continue exactly where it stopped, without repeating what you already wrote.'
          )
        )
        continue
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
        skippedForSteering.push(skipped.toolName)
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
              'schema describes.',
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
        observed.push({
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
      observed.push({
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
      })
      if (await yieldToSteering(index)) break
    }

    if (result.toolCalls.length > 0 && !signal.aborted) {
      try {
        deps.onBatchFinished?.(result.toolCalls.map((c) => c.toolName))
      } catch {
        // Observing a batch must never end a run.
      }
    }

    /**
     * Stop a run that has stopped getting anywhere. AH-029/AH-030.
     *
     * Counted from what happened rather than asked of the model: a model in a
     * loop is the one most likely to insist it is about to finish, so the
     * guard is not something it can waive.
     */
    const loop = detectLoop(observed)
    if (loop.tripped && !steeringPending) {
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
        messages.push(
          assistantMessageFor(deps.nextMessageId(), result, outcomes)
        )
      }
      deps.onStep({ step, result, turns: turnsFor(result, outcomes), outcomes })
      step = await closingTurn(messages, deps, signal, step, (u) => {
        usage = u
        spend = recordSpend(spend, u)
      })
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'loop',
        errorText: loopStopNotice(loop),
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
    // A call whose answer hands the work to a new run: finished, not stopped.
    if ([...outcomes.values()].some((one) => one.endsTurn)) {
      return {
        messages,
        steps: step,
        usage,
        sessionTokens: spend.spent,
        stoppedBy: 'done',
      }
    }
    // No tool calls means the model answered rather than asked for more work.
    if (result.toolCalls.length === 0) {
      // Input that arrived while that answer was written continues this run:
      // the answer is already in the history, the input follows it, and the
      // model replies to both. The caps are checked again at the top.
      const late = (await deps.takeSteering?.()) ?? []
      if (late.length > 0) {
        messages.push(...late)
        continue
      }
      if (!autoContinued && result.finishReason === 'length' && result.text.trim()) {
        autoContinued = true
        messages.push(
          nudge(
            'Your previous reply was cut off by the output limit. Continue exactly where it stopped, without repeating what you already wrote.'
          )
        )
        continue
      }
      if (!autoContinued && !result.text.trim()) {
        autoContinued = true
        messages.push(
          nudge(
            'Your last reply had no text and no tool call. Answer the request, or call a tool to continue the work.'
          )
        )
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

export const __testing = { handles }
