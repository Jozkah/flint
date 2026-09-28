/**
 * The model-call port shared by the engine and the participant model adapter,
 * and the normalisation of anything a call throws.
 *
 * Kept apart from `participantModel.ts` so the engine does not load the model
 * factory or the AI SDK just to classify an error.
 */
import { isContextOverflow } from '@/lib/coworkBudget'
import { isAbortLike } from '@/lib/coworkRunner'
import { parseServerContextLimit } from '@/lib/contextLimitRecovery'
import { classifyFailure, type FailureClass, type FailureFacts } from '@/lib/runRetry'
import { redactSecrets } from '@/lib/redact'
import type { PromptMessage } from './context'
import type {
  ParticipantReasoning,
  RoomModelRef,
  RoomToolActivity,
  ToolAccess,
} from './types'

export type { RoomToolActivity }

/**
 * What a tool-capable participant may read while it takes its turn. Present only
 * when the room has a working folder and the participant has tool access; the
 * model adapter turns it into the read-only built-in tools, executed against the
 * folder. Kept as plain data so the engine need not load the AI SDK or the tool
 * plumbing.
 */
export type RoomToolContext = {
  roomId: string
  /** The folder file-read tools resolve against, or null for none. */
  folder: string | null
  access: ToolAccess
}

export type StreamReplyInput = {
  model: RoomModelRef
  /** The speaking participant's reasoning setting; absent for the model's default. */
  reasoning?: ParticipantReasoning
  system: string
  messages: PromptMessage[]
  maxOutputTokens: number
  signal: AbortSignal
  /** Text deltas only; reasoning is never passed here. */
  onText: (delta: string) => void
  /** Read-only tools for this turn, when the participant may use them. */
  toolContext?: RoomToolContext
  /** Reports each tool the participant runs, for the live/settled transcript. */
  onToolActivity?: (activity: RoomToolActivity) => void
}

export type StreamReplyResult = {
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
  finishReason: string
  /** The tools the participant used, in call order. */
  toolActivity?: RoomToolActivity[]
}

export type StreamReply = (input: StreamReplyInput) => Promise<StreamReplyResult>

export type RoomCallErrorKind =
  | 'aborted'
  | 'overflow'
  | 'load-failed'
  | 'unavailable'
  | 'provider'

export class RoomCallError extends Error {
  readonly kind: RoomCallErrorKind
  readonly code: string
  readonly facts: FailureFacts
  constructor(kind: RoomCallErrorKind, code: string, message: string, facts: FailureFacts = {}) {
    super(message)
    this.name = kind === 'aborted' ? 'AbortError' : 'RoomCallError'
    this.kind = kind
    this.code = code
    this.facts = facts
  }
}

const OVERFLOW_TEXT =
  /(context (length|window)|maximum context|too many tokens|prompt is too long|exceeds? the (model'?s )?(context|maximum))/i

function statusOf(e: unknown): number | null {
  const o = e as { statusCode?: unknown; status?: unknown } | null
  const s = o?.statusCode ?? o?.status
  return typeof s === 'number' ? s : null
}

function retryAfterOf(e: unknown): string | null {
  const headers = (e as { responseHeaders?: Record<string, string> } | null)?.responseHeaders
  if (!headers) return null
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'retry-after')
  return key ? headers[key] : null
}

/**
 * Cleaned, bounded error message with credentials redacted. It is stored in
 * the journal and shown in system notes, so secrets are removed before the
 * text is truncated (a cut could otherwise hide a token from the filter).
 */
export function cleanErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error'
  return redactSecrets(raw.replace(/\s+/g, ' ').trim()).slice(0, 500) || 'Unknown error'
}

/** Normalise anything thrown by a model call. */
export function toRoomCallError(e: unknown, signal?: AbortSignal): RoomCallError {
  if (e instanceof RoomCallError) return e
  if (isAbortLike(e, signal)) {
    return new RoomCallError('aborted', 'cancelled', 'The turn was cancelled.', { aborted: true })
  }
  const message = cleanErrorMessage(e)
  const facts: FailureFacts = {
    status: statusOf(e),
    retryAfter: retryAfterOf(e),
    message,
  }
  let serverLimit = null
  try {
    serverLimit = parseServerContextLimit((e as { data?: unknown } | null)?.data ?? null, message)
  } catch {
    serverLimit = null
  }
  if (isContextOverflow(e) || OVERFLOW_TEXT.test(message) || serverLimit != null) {
    return new RoomCallError('overflow', 'context-overflow', message, facts)
  }
  const failure: FailureClass = classifyFailure(facts)
  const code = facts.status != null ? `${failure}:${facts.status}` : failure
  return new RoomCallError('provider', code, message, facts)
}
