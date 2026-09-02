/**
 * Turning a temporary chat into a permanent one, and deciding when to ask.
 *
 * A temporary chat is never written to disk: the threads and messages services
 * both short-circuit for `TEMPORARY_CHAT_ID`. That makes it genuinely
 * throwaway, and it makes keeping one an explicit act of copying — every
 * message has to be re-addressed to a new thread and written for the first
 * time.
 *
 * It also means the id is *reused*: the next temporary chat is the same id
 * again. Anything left behind under it — messages, per-chat model overrides,
 * transient generation state — becomes the next chat's inheritance, so discard
 * has to be exhaustive rather than approximate.
 *
 * Pure and store-free: the decisions are testable without React.
 */

import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import type { ModelOverrides } from '@/lib/modelOverrides'

/** What the user chose when told a temporary chat would be lost. */
export type LeaveDecision = 'keep' | 'discard' | 'cancel'

/**
 * Is there anything here worth asking about?
 *
 * An empty temporary chat is not worth a dialog — there is nothing to lose,
 * and prompting would make every stray click feel dangerous.
 */
export function isEmptyTemporaryChat(
  messages: { id: string }[] | undefined
): boolean {
  return !messages || messages.length === 0
}

/** Should leaving this chat be interrupted with a question? */
export function shouldConfirmLeaving(input: {
  threadId: string | null | undefined
  messages: { id: string }[] | undefined
}): boolean {
  return (
    input.threadId === TEMPORARY_CHAT_ID && !isEmptyTemporaryChat(input.messages)
  )
}

/**
 * A message, re-addressed to the thread that is about to hold it.
 *
 * Everything else is carried verbatim — attachments, tool calls, token counts
 * and whatever else lives in `metadata` — because the point of keeping a chat
 * is that it is the same conversation, not a summary of one. Only the id it
 * belongs to changes.
 */
export function readdressMessage<T extends { thread_id: string }>(
  message: T,
  threadId: string
): T {
  return { ...message, thread_id: threadId }
}

export function readdressMessages<T extends { thread_id: string }>(
  messages: T[],
  threadId: string
): T[] {
  return messages.map((message) => readdressMessage(message, threadId))
}

/**
 * A title for the kept chat.
 *
 * Taken from what the user actually said first, because "Temporary Chat" is a
 * description of the container and tells them nothing later. Trimmed to a
 * sensible length, and falling back to a neutral name when the first message
 * carries no text (an image, say).
 */
export function titleForKeptChat(
  firstUserText: string | undefined,
  fallback: string
): string {
  const text = firstUserText?.trim().replace(/\s+/g, ' ')
  if (!text) return fallback
  return text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text
}

/** Why a promotion did not happen. Each one is something to tell the user. */
export type PromotionFailure =
  /** The thread could not be created. */
  | 'thread-not-created'
  /** The thread was created but its messages did not all arrive. */
  | 'messages-not-persisted'
  /** Generation was still running and could not be stopped. */
  | 'generation-not-stopped'
  /** Something threw. */
  | 'error'

export type PromotionResult =
  | { ok: true; threadId: string }
  | { ok: false; reason: PromotionFailure; detail?: string }

/**
 * Did everything we wrote actually land?
 *
 * The services swallow their own errors — `createThread` and `createMessage`
 * both fall back to returning what they were given — so a write that failed is
 * indistinguishable from one that worked by its return value alone. The only
 * honest check is to read the thread back and compare. Nothing is deleted
 * until this says yes.
 */
export function persistedEverything(
  expected: { id: string }[],
  actual: { id: string }[] | undefined
): boolean {
  if (!actual) return false
  const seen = new Set(actual.map((message) => message.id))
  return expected.every((message) => seen.has(message.id))
}

/**
 * Did the thread we just created actually land in durable storage?
 *
 * `createThread` swallows its own write errors and hands back the thread it was
 * given, so a thread that never reached disk is indistinguishable from one that
 * did by the return value alone. The honest check is to read the thread list
 * back from the persistence boundary and look for the id. Without this a failed
 * thread write would look like success, and — because the foreign-key link from
 * messages to threads is the only thing standing between us and orphan rows —
 * the messages check alone would be trusting an implementation detail rather
 * than proving the thread is there.
 */
export function persistedThread(
  threadId: string,
  threads: { id: string }[] | undefined
): boolean {
  if (!threads) return false
  return threads.some((thread) => thread.id === threadId)
}

/**
 * Everything a discarded temporary chat leaves behind, by name.
 *
 * Listed in one place because the id is reused: a store forgotten here is one
 * the *next* temporary chat silently inherits.
 */
export const TEMPORARY_STATE_OWNERS = [
  'thread',
  'messages',
  'appState',
  'modelOverrides',
  'attachments',
] as const

export type TemporaryStateOwner = (typeof TEMPORARY_STATE_OWNERS)[number]

/** Sparse overrides to carry across, if the chat had any. */
export function overridesToCarry(
  overrides: ModelOverrides | undefined
): ModelOverrides | undefined {
  if (!overrides || Object.keys(overrides).length === 0) return undefined
  return { ...overrides }
}
