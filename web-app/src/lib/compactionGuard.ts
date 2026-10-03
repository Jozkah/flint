/**
 * Guards around Chat's threshold compaction (`lib/compaction.ts`).
 *
 * - Rapid-refill breaker: a conversation that crosses the threshold again a
 *   few messages after a compaction is not helped by another summary (the
 *   window is full of something the summary cannot shrink), so after repeated
 *   rapid refills compaction stops and the user is told, instead of looping.
 * - Precompute: close to the threshold the summary is started in the
 *   background, so the request that crosses it does not wait for the model.
 *
 * Both keep state per thread, in memory.
 */
import type { UIMessage } from 'ai'
import { transcriptForSummary, type Summarize } from '@/lib/compaction'

/** Share of the compaction threshold at which the summary is precomputed. */
export const PRECOMPUTE_FRACTION = 0.8

/** Messages after a compaction within which a refill counts as rapid. */
export const RAPID_REFILL_MESSAGES = 3

/** Consecutive rapid refills after which automatic compaction stops. */
export const MAX_RAPID_REFILLS = 2

export class CompactionLoopError extends Error {
  constructor() {
    super(
      'The conversation keeps refilling the context right after it is compacted, so automatic compaction has stopped. Start a new chat, remove large attachments or tool output, or compact manually with /compact.'
    )
    this.name = 'CompactionLoopError'
  }
}

type BreakerState = { messageCount: number; streak: number }

const breakers = new Map<string, BreakerState>()

/**
 * Whether a compaction now would be one more in a rapid-refill loop.
 * `messageCount` is the length of the history the threshold was crossed on.
 */
export function isCompactionLooping(
  threadId: string,
  messageCount: number
): boolean {
  const state = breakers.get(threadId)
  if (!state) return false
  const rapid = messageCount - state.messageCount <= RAPID_REFILL_MESSAGES
  return rapid && state.streak >= MAX_RAPID_REFILLS - 1
}

/** Note a compaction; `messageCount` is the length of the history it produced. */
export function recordCompaction(
  threadId: string,
  priorMessageCount: number,
  messageCount: number
): void {
  const state = breakers.get(threadId)
  const rapid =
    !!state && priorMessageCount - state.messageCount <= RAPID_REFILL_MESSAGES
  breakers.set(threadId, {
    messageCount,
    streak: rapid ? state.streak + 1 : 0,
  })
}

/** Forget a thread's refill history, after a manual compaction or a reset. */
export function resetCompactionBreaker(threadId: string): void {
  breakers.delete(threadId)
}

/**
 * Identifies the messages a summary covers. A different set, or the same ids
 * with edited content, is a different key and the summary is not reused.
 */
export function prefixKey(messages: UIMessage[]): string {
  return `${messages.map((m) => m.id).join(',')}#${transcriptForSummary(messages).length}`
}

/**
 * Messages a precomputed summary may trail the covered prefix by and still be
 * used: the summary then folds what it covers and the few newer messages stay
 * verbatim. Further behind than this, it is worth less than a fresh one.
 */
export const MAX_STALE_PREFIX_MESSAGES = 6

type Precomputed = {
  key: string
  /** How many messages the summary covers. */
  count: number
  summary: Promise<string | null>
  controller: AbortController
  settled: boolean
}

const precomputed = new Map<string, Precomputed>()

function coversPrefixOf(entry: Precomputed, covered: UIMessage[]): boolean {
  return (
    covered.length >= entry.count &&
    prefixKey(covered.slice(0, entry.count)) === entry.key
  )
}

/**
 * Start summarizing `covered` in the background, at most once per thread and
 * covered prefix. While the conversation only grows past what a precompute
 * already covers (and not by more than [`MAX_STALE_PREFIX_MESSAGES`]), nothing
 * is started: the earlier summary is still the one the compaction will use. A
 * conversation that was edited, or has run on far past it, replaces it.
 */
export function startPrecompute(
  threadId: string,
  covered: UIMessage[],
  summarize: Summarize
): void {
  const existing = precomputed.get(threadId)
  if (existing) {
    if (
      coversPrefixOf(existing, covered) &&
      covered.length - existing.count <= MAX_STALE_PREFIX_MESSAGES
    ) {
      return
    }
    if (!existing.settled) existing.controller.abort()
  }

  const controller = new AbortController()
  const entry: Precomputed = {
    key: prefixKey(covered),
    count: covered.length,
    controller,
    settled: false,
    summary: summarize(transcriptForSummary(covered), controller.signal)
      .catch(() => null)
      .finally(() => {
        entry.settled = true
      }),
  }
  precomputed.set(threadId, entry)
}

/**
 * The precomputed summary, consumed, when it covers a leading part of
 * `covered` that is no more than [`MAX_STALE_PREFIX_MESSAGES`] short of it;
 * `count` is how many leading messages it covers. Null when there is none or
 * it covers something else (the caller then summarizes itself).
 */
export function takePrecomputedPrefix(
  threadId: string,
  covered: UIMessage[]
): { count: number; summary: Promise<string | null> } | null {
  const entry = precomputed.get(threadId)
  if (
    !entry ||
    !coversPrefixOf(entry, covered) ||
    covered.length - entry.count > MAX_STALE_PREFIX_MESSAGES
  ) {
    return null
  }
  precomputed.delete(threadId)
  return { count: entry.count, summary: entry.summary }
}

/** The precomputed summary for exactly this prefix, consumed. */
export function takePrecomputed(
  threadId: string,
  covered: UIMessage[]
): Promise<string | null> | null {
  const entry = precomputed.get(threadId)
  if (!entry || entry.count !== covered.length) return null
  return takePrecomputedPrefix(threadId, covered)?.summary ?? null
}

/** Abandon a thread's precompute, aborting its model call if still running. */
export function cancelPrecompute(threadId: string): void {
  const entry = precomputed.get(threadId)
  if (!entry) return
  precomputed.delete(threadId)
  if (!entry.settled) entry.controller.abort()
}
