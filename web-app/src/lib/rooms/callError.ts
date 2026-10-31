/**
 * The model-call port shared by the engine and the participant model adapter,
 * and the normalisation of anything a call throws.
 *
 * Kept apart from `participantModel.ts` so the engine does not load the model
 * factory or the AI SDK just to classify an error.
 */
import { isContextLengthError } from '@/lib/compaction'
import { isAbortLike } from '@/lib/coworkRunner'
import { parseServerContextLimit } from '@/lib/contextLimitRecovery'
import { classifyFailure, type FailureClass, type FailureFacts } from '@/lib/runRetry'
import { redactSecrets } from '@/lib/redact'
import type { PromptMessage } from './context'
import type {
  ParticipantReasoning,
  RoomBudgetHit,
  RoomModelRef,
  RoomToolActivity,
  RoomToolBudget,
  ToolAccess,
} from './types'

export type { RoomToolActivity }
export { turnToolAccess } from './types'

/**
 * What a tool-capable participant may read while it takes its turn. Present only
 * when the room has a working folder and the participant has tool access; the
 * model adapter turns it into the read-only built-in tools, executed against the
 * folder. Kept as plain data so the engine need not load the AI SDK or the tool
 * plumbing.
 */
/**
 * The session a participant's write grant belongs to. A session holds one
 * grant, so two editing participants keyed by the room alone replaced each
 * other's: each gets its own.
 */
export function grantSessionId(ctx: { roomId: string; participantId?: string }): string {
  return ctx.participantId ? `${ctx.roomId}--${ctx.participantId}` : ctx.roomId
}

export type RoomToolContext = {
  roomId: string
  /** The folder file-read tools resolve against, or null for none. */
  folder: string | null
  /** More folders beside `folder`, reachable the same way. */
  extraFolders?: string[]
  access: ToolAccess
  /** Who is speaking, named on the approval prompts their calls raise. */
  participantName?: string
  /** The speaking participant's id: what its own state (its plan) is kept under. */
  participantId?: string
  /** The turn's signal: stopping it withdraws any prompt still open. */
  signal?: AbortSignal
  /**
   * Tokens the room may still spend before its own limit, when it has one. A
   * subagent a participant starts is held to it, so delegation cannot spend what
   * the room was not given.
   */
  tokenBudget?: number
  /** The room's per-turn tool budget; absent uses the defaults. */
  budget?: RoomToolBudget
  /**
   * The access the participant was given, when the turn runs with less (a
   * compare-mode writer reads only). Sizes the default step budget, so the
   * downgrade narrows what it may do, not how long it may work.
   */
  budgetAccess?: ToolAccess
  /** Tools the user switched off for this participant. */
  disabledTools?: string[]
  /**
   * The label an approval this turn raises keeps when the turn is stopped by
   * a pause (`room paused`), or null when the stop is not a pause.
   */
  holdLabel?: () => string | null
}

export type StreamReplyInput = {
  model: RoomModelRef
  /** The speaking participant's reasoning setting; absent for the model's default. */
  reasoning?: ParticipantReasoning
  /** Sampling from the participant's assistant (temperature, top_p...), when it has one. */
  sampling?: Record<string, number>
  system: string
  messages: PromptMessage[]
  maxOutputTokens: number
  /**
   * The speaker's own context window. A turn that runs tools measures each
   * step's request against it and clears old tool output, or ends the tool
   * loop, before the window is crossed. Absent: no per-step guard.
   */
  contextBudget?: { window: number }
  signal: AbortSignal
  /** Text deltas only; reasoning is never passed here. */
  onText: (delta: string) => void
  /** Any piece of output arriving (text, reasoning, tool-call arguments), for timing. */
  onStreamActivity?: () => void
  /** Read-only tools for this turn, when the participant may use them. */
  toolContext?: RoomToolContext
  /** Reports each tool the participant runs, for the live/settled transcript. */
  onToolActivity?: (activity: RoomToolActivity) => void
}

export type StreamReplyResult = {
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
  finishReason: string
  /** What the model thought, when the provider streamed it separately. */
  reasoning?: string
  /** The tools the participant used, in call order. */
  toolActivity?: RoomToolActivity[]
  /** The tool budget the turn ran into, when it did. */
  budgetHit?: RoomBudgetHit
}

export type StreamReply = (input: StreamReplyInput) => Promise<StreamReplyResult>

export type RoomCallErrorKind =
  | 'aborted'
  | 'overflow'
  | 'load-failed'
  | 'unavailable'
  | 'provider'
  | 'busy'

/**
 * A local engine refused because every model slot is taken ("all N model slots
 * are busy; retry shortly"). It is a wait, not a failure of the model.
 */
export function isSlotBusyMessage(message: string): boolean {
  return /model slots? (are|is) busy|retry shortly/i.test(message)
}

export class RoomCallError extends Error {
  readonly kind: RoomCallErrorKind
  readonly code: string
  readonly facts: FailureFacts
  /**
   * The window a refusal for length named, when the server said one. The
   * engine plans against it from then on, so the retry is sized to the real
   * limit instead of a guess.
   */
  readonly contextLimit: number | null
  constructor(
    kind: RoomCallErrorKind,
    code: string,
    message: string,
    facts: FailureFacts = {},
    contextLimit: number | null = null
  ) {
    super(message)
    this.contextLimit = contextLimit
    this.name = kind === 'aborted' ? 'AbortError' : 'RoomCallError'
    this.kind = kind
    this.code = code
    this.facts = facts
  }
}

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
  if (isSlotBusyMessage(message)) return new RoomCallError('busy', 'busy', message, facts)
  let serverLimit = null
  try {
    serverLimit = parseServerContextLimit((e as { data?: unknown } | null)?.data ?? null, message)
  } catch {
    serverLimit = null
  }
  // The shared test: "too many tokens per minute" is throttling, which
  // compaction cannot help and the backoff can, so it is not an overflow.
  if (serverLimit != null || isContextLengthError(e)) {
    return new RoomCallError(
      'overflow',
      'context-overflow',
      message,
      facts,
      serverLimit?.contextTokens ?? null
    )
  }
  const failure: FailureClass = classifyFailure(facts)
  const code = facts.status != null ? `${failure}:${facts.status}` : failure
  return new RoomCallError('provider', code, message, facts)
}
