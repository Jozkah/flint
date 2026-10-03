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

type Precomputed = {
  key: string
  summary: Promise<string | null>
  controller: AbortController
  settled: boolean
}

const precomputed = new Map<string, Precomputed>()

/**
 * Start summarizing `covered` in the background, once: nothing happens while a
 * precompute for the thread is still running or already holds this prefix.
 */
export function startPrecompute(
  threadId: string,
  covered: UIMessage[],
  summarize: Summarize
): void {
  const key = prefixKey(covered)
  const existing = precomputed.get(threadId)
  if (existing && (existing.key === key || !existing.settled)) return

  const controller = new AbortController()
  const entry: Precomputed = {
    key,
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
 * The precomputed summary for exactly this prefix, consumed; null when there
 * is none or it covers something else (the caller then summarizes itself).
 */
export function takePrecomputed(
  threadId: string,
  covered: UIMessage[]
): Promise<string | null> | null {
  const entry = precomputed.get(threadId)
  if (!entry || entry.key !== prefixKey(covered)) return null
  precomputed.delete(threadId)
  return entry.summary
}

/** Abandon a thread's precompute, aborting its model call if still running. */
export function cancelPrecompute(threadId: string): void {
  const entry = precomputed.get(threadId)
  if (!entry) return
  precomputed.delete(threadId)
  if (!entry.settled) entry.controller.abort()
}
