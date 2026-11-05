import type { UIMessage } from 'ai'
import type { QueuedMessageSender } from '@/stores/message-queue-store'
import type { CoworkTurn, Usage } from '@/types/coworkSession'
import { fromCoworkUsage, toCoworkUsage } from '@/lib/tokenUsage'

/** Rows that carry no time yet get the one they are stored at. */
export const stamped = (turns: CoworkTurn[]): CoworkTurn[] => {
  const at = Date.now()
  return turns.some((t) => t.at === undefined)
    ? turns.map((t) => (t.at === undefined ? { ...t, at } : t))
    : turns
}

const timeOf = (m: UIMessage): unknown =>
  (m.metadata as { createdAt?: unknown } | undefined)?.createdAt

/**
 * Every stored message keeps the time it was first stored with. A message
 * without one (assistant replies, delivered mail) used to be shown with the
 * time it was rendered, so after a restart old messages read as new (live
 * test 10). It takes the time it had when last stored, or `at`.
 */
export function withStoredTimes(
  before: readonly UIMessage[],
  next: UIMessage[],
  at: number
): UIMessage[] {
  if (next.every((m) => timeOf(m) !== undefined)) return next
  let previous: Map<string, unknown> | null = null
  return next.map((m) => {
    if (timeOf(m) !== undefined) return m
    previous ??= new Map(before.map((b) => [b.id, timeOf(b)]))
    const createdAt = previous.get(m.id) ?? at
    return {
      ...m,
      metadata: { ...((m.metadata as object | undefined) ?? {}), createdAt },
    }
  })
}

/** An imported session's usage, normalised the same way a live one is. */
export function importedUsage(raw: unknown): Usage | undefined {
  const usage = fromCoworkUsage(
    raw && typeof raw === 'object' ? (raw as Usage) : undefined
  )
  return usage && Object.keys(usage).length > 0 ? toCoworkUsage(usage) : undefined
}

/** Only the sender fields the queue defines are persisted. */
export function sanitizeSender(from: QueuedMessageSender): QueuedMessageSender {
  return {
    sessionId: from.sessionId,
    displayName: from.displayName,
    messageId: from.messageId,
    replyTo: from.replyTo ?? null,
    depth: from.depth,
    ...(from.hold ? { hold: from.hold } : {}),
  }
}
