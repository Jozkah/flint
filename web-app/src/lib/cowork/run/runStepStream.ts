/* eslint-disable @typescript-eslint/no-explicit-any */
// One model step of a Cowork run: the stream folded into a step result, and
// the turns and assistant message it becomes.

import type { UIMessage, UIMessageChunk } from 'ai'
import type { CoworkTurn, TurnMemory, Usage } from '@/types/coworkSession'
import { readTokenUsage, toCoworkUsage } from '@/lib/tokenUsage'
import { recoverToolArgs } from '@/lib/toolCallRepair'
import { toolOutputWithImages } from '@/lib/toolOutputImages'
import { invalidArgsMessage, refusalKindOf } from './runnerToolArgs'
import type { PendingToolCall, StepResult, ToolOutcome } from '@/lib/coworkRunner'

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

// The cache counts ride along: dropping them here was where a provider's
// cache report used to stop on its way to the Cowork counter.
export const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

export const memoryOf = (meta: unknown): TurnMemory | undefined => {
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

export const usageOf = (meta: unknown): Usage | null => {
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
  /**
   * Any generated output arrived: text, reasoning or tool-call arguments. The
   * span between the first and last is what a generation speed divides by.
   */
  onOutput?: (chars: number) => void
}

export function stopReason(signal: AbortSignal): unknown {
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
  signal?: AbortSignal,
  /** Called for every chunk, so an idle timeout measures silence, not length. */
  onActivity?: () => void
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
      onActivity?.()
      const chunk = value as any
      switch (chunk.type) {
        case 'text-delta':
          result.text += chunk.delta
          sink.onOutput?.(chunk.delta.length)
          sink.onText(chunk.delta)
          break
        case 'reasoning-delta':
          sink.onOutput?.(chunk.delta?.length ?? 0)
          break
        case 'tool-input-start':
          sink.onToolStart(chunk.toolCallId, chunk.toolName)
          break
        case 'tool-input-delta':
          sink.onOutput?.(chunk.inputTextDelta?.length ?? 0)
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
              : // Never for a tool the run did not offer: repairing its
                // arguments would dispatch it past the refusal below.
                offered && typeof raw === 'string'
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
      input: outcome?.ranInput ?? call.input,
      state: outcome
        ? outcome.isError
          ? 'output-error'
          : 'output-available'
        : 'input-available',
    }
    if (outcome) {
      if (outcome.isError) part.errorText = outcome.output
      else part.output = toolOutputWithImages(outcome.output, outcome.images)
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
      args: outcome?.ranInput ?? call.input,
      result: outcome?.output ?? '',
      isError: outcome?.isError,
      diff: outcome?.diff,
      ...(outcome?.images?.length ? { toolImages: outcome.images } : {}),
      status: outcome ? 'done' : 'running',
    })
  }
  return turns
}
