import type { UIMessage } from '@ai-sdk/react'
import { isContextOverflowMessage } from '@/utils/error'
import { LLAMACPP_CRASH_MESSAGE } from '@/lib/model/transportErrors'

/**
 * Getting a local turn back to an answer after its engine went away, without
 * the user retyping anything.
 *
 * When llama.cpp dies under a request (the child crashed, the router went
 * down, the connection was cut mid-answer) the turn is retried once on its
 * own after the model is loaded again. A turn whose earlier steps already ran
 * tools is resumed after them, their results reused by `toolCallId`, so no
 * tool ever runs twice. Nothing is deleted from the thread.
 *
 * Context overflow is not handled here: the transport already compacts and
 * resends a request the engine refused for its length (overflowRecovery.ts),
 * and the context banner covers the rest.
 */

/** Providers whose engine Flint runs itself and can load again. */
const RECOVERABLE_LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['llamacpp'])

export function isRecoverableLocalProvider(provider: string | undefined): boolean {
  return !!provider && RECOVERABLE_LOCAL_PROVIDERS.has(provider)
}

/** Automatic retries one turn gets. A second failure is shown as it is. */
export const MAX_AUTO_RETRIES_PER_TURN = 1

/**
 * OS error codes of a refused or dropped loopback connection: Windows
 * WSAECONNREFUSED (10061), WSAECONNRESET (10054), WSAECONNABORTED (10053);
 * ECONNREFUSED on macOS (61) and Linux (111); ECONNRESET on macOS (54) and
 * Linux (104). Windows words these in the user's language, so the code is
 * what is matched.
 */
const ENGINE_GONE_OS_ERRORS: ReadonlySet<number> = new Set([
  10061, 10054, 10053, 61, 111, 54, 104,
])

type ErrorRecord = {
  name?: unknown
  message?: unknown
  responseBody?: unknown
  cause?: unknown
  statusCode?: unknown
  status?: unknown
}

/** Message, raw response body and cause: everywhere the reason can sit. */
function errorText(error: unknown, depth = 0): string {
  if (error == null || depth > 2) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return ''
  const record = error as ErrorRecord
  return [
    typeof record.message === 'string' ? record.message : '',
    typeof record.responseBody === 'string' ? record.responseBody : '',
    errorText(record.cause, depth + 1),
  ]
    .filter(Boolean)
    .join(' ')
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as ErrorRecord
  const code = record.statusCode ?? record.status
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined
}

/**
 * A stop the user asked for. The transport answers a cancelled stream with
 * exactly `request cancelled` (`Request aborted` from older paths); the
 * Windows text of 10053 says "aborted" too and is not one, so this does not
 * look for the word in general.
 */
function isUserAbort(error: unknown): boolean {
  if (error && typeof error === 'object') {
    if ((error as ErrorRecord).name === 'AbortError') return true
  }
  return /^\s*(?:Request aborted|request cancelled)\s*$/i.test(errorText(error))
}

/** `localhost:8080 could not connect…` / `…failed…`: the transport's own words for a loopback failure. */
const LOOPBACK_FAILURE =
  /\b(?:localhost|127\.0\.0\.1|\[::1\]):\d+ (?:could not connect|failed)\b/i
const DROPPED_CONNECTION =
  /connection (?:refused|reset|closed|aborted)|broken pipe|unexpected eof|error decoding response body/i
const AUTH_FAILURE = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key/i

/**
 * Whether a local turn failed because its engine is gone: llama.cpp crashed
 * (the router answered 500 with no body), nothing listened on its port, or
 * the connection was cut mid-answer. Never a user stop, a timeout (the engine
 * may only be slow), an auth or other 4xx answer, or a context overflow: a
 * retry would not help those.
 */
export function isEngineGoneError(error: unknown): boolean {
  if (!error || isUserAbort(error)) return false
  const text = errorText(error)
  if (!text) return false
  if (isContextOverflowMessage(text)) return false
  const status = statusOf(error)
  if (status !== undefined && status >= 400 && status < 500) return false
  if (AUTH_FAILURE.test(text)) return false
  if (text.includes(LLAMACPP_CRASH_MESSAGE)) return true
  if (/timed out|timeout/i.test(text)) return false
  if (LOOPBACK_FAILURE.test(text) || DROPPED_CONNECTION.test(text)) return true
  const code = /\(os error (\d+)\)/i.exec(text)?.[1]
  return code !== undefined && ENGINE_GONE_OS_ERRORS.has(Number(code))
}

type Part = UIMessage['parts'][number]

function isToolPart(part: Part): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** A tool part whose result was delivered (or whose failure was). */
function isResolvedToolPart(part: Part): boolean {
  if (!isToolPart(part)) return false
  const state = (part as { state?: string }).state
  return state === 'output-available' || state === 'output-error'
}

/** `toolCallId`s of the tool calls in `message` that already ran. */
export function resolvedToolCallIds(message: UIMessage | undefined): string[] {
  if (!message || message.role !== 'assistant') return []
  return message.parts
    .filter(isResolvedToolPart)
    .map((part) => (part as { toolCallId?: string }).toolCallId)
    .filter((id): id is string => typeof id === 'string')
}

/** The user message that started the turn the conversation ends with. */
export function turnUserMessageId(
  messages: readonly UIMessage[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].id
  }
  return undefined
}

/**
 * The failed assistant message cut back to its last tool call that ran: the
 * failed step's partial text and any call it queued but never ran go, every
 * call that ran keeps its result (each `toolCallId` once). Continuing from
 * here sends those results to the model instead of running the calls again.
 */
export function resumableAssistantMessage(message: UIMessage): UIMessage {
  let lastResolved = -1
  message.parts.forEach((part, index) => {
    if (isResolvedToolPart(part)) lastResolved = index
  })
  const seen = new Set<string>()
  const parts = message.parts.slice(0, lastResolved + 1).filter((part) => {
    if (!isToolPart(part)) return true
    if (!isResolvedToolPart(part)) return false
    const id = (part as { toolCallId?: string }).toolCallId
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  const metadata = message.metadata as Record<string, unknown> | undefined
  if (!metadata || !('error' in metadata)) return { ...message, parts }
  const rest = { ...metadata }
  delete rest.error
  return { ...message, parts, metadata: rest }
}

export type EngineRecoveryPlan =
  | {
      /** Answer the turn again from its user message. */
      kind: 'regenerate'
      /** The user message the turn started from; the retry cap is per key. */
      turnKey: string
      /** The failed assistant message the retry replaces, when there is one. */
      failedMessageId: string | undefined
    }
  | {
      /**
       * Continue the failed assistant message after its finished tool calls:
       * their results are sent again, the calls are not run again.
       */
      kind: 'resume'
      turnKey: string
      failedMessageId: string
      /** The conversation to continue: the failed message cut back. */
      messages: UIMessage[]
      reusedToolCallIds: string[]
    }

/**
 * How to retry the turn the conversation ends with, or `undefined` when there
 * is none. A turn whose earlier steps already ran tools is resumed in place:
 * a regenerate would throw their results away and the model would ask for
 * the same calls again -- a command run twice, a message sent twice.
 */
export function planEngineRecovery(
  messages: readonly UIMessage[]
): EngineRecoveryPlan | undefined {
  const turnKey = turnUserMessageId(messages)
  if (!turnKey) return undefined
  const last = messages.at(-1)
  if (!last) return undefined
  if (last.role === 'user') {
    return { kind: 'regenerate', turnKey, failedMessageId: undefined }
  }
  const reusedToolCallIds = resolvedToolCallIds(last)
  if (reusedToolCallIds.length === 0) {
    return { kind: 'regenerate', turnKey, failedMessageId: last.id }
  }
  return {
    kind: 'resume',
    turnKey,
    failedMessageId: last.id,
    messages: [...messages.slice(0, -1), resumableAssistantMessage(last)],
    reusedToolCallIds: [...new Set(reusedToolCallIds)],
  }
}

/**
 * Turns, by the id of the user message that started them, and how many
 * automatic retries each has had. Module-wide, not per render: a thread's
 * Chat (and its error) outlives the page, and a page mounted again on the
 * same failed turn must not retry it again.
 */
const autoRetries = new Map<string, number>()

/** Takes one automatic retry for `turnKey`; false once the cap is spent. */
export function claimAutoRetry(turnKey: string): boolean {
  const used = autoRetries.get(turnKey) ?? 0
  if (used >= MAX_AUTO_RETRIES_PER_TURN) return false
  autoRetries.set(turnKey, used + 1)
  return true
}

/** Test seam. */
export function resetAutoRetries(): void {
  autoRetries.clear()
}
