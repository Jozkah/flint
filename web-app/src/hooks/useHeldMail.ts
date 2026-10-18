import { useMemo } from 'react'
import {
  useMessageQueue,
  type QueuedMessage,
} from '@/stores/message-queue-store'
import { useNeedsApproval } from '@/hooks/useNeedsApproval'

/** A held message from another agent session, waiting for the user. */
export type HeldMail = QueuedMessage & {
  from: NonNullable<QueuedMessage['from']>
}

const isHeldMail = (m: QueuedMessage): m is HeldMail => !!m.held && !!m.from

/** One session's held mail, oldest first. */
export function heldMailOf(queue: readonly QueuedMessage[]): HeldMail[] {
  return queue.filter(isHeldMail).sort((a, b) => a.createdAt - b.createdAt)
}

/** Every session with held mail: its id, how many, and the latest sender. */
export type HeldMailSummary = {
  sessionId: string
  count: number
  from: string
}

export function summarizeHeldMail(
  queues: Record<string, readonly QueuedMessage[]>
): HeldMailSummary[] {
  const out: HeldMailSummary[] = []
  for (const [sessionId, queue] of Object.entries(queues)) {
    const mail = heldMailOf(queue)
    if (mail.length === 0) continue
    out.push({
      sessionId,
      count: mail.length,
      from: mail[mail.length - 1].from.displayName,
    })
  }
  return out
}

/** How many messages from other sessions wait for the user in `sessionId`. */
export function useHeldMailCount(sessionId: string | undefined): number {
  return useMessageQueue((s) =>
    sessionId ? heldMailOf(s.getQueue(sessionId)).length : 0
  )
}

/** Sessions with held mail, for the notifications menu. */
export function useHeldMailSummary(): HeldMailSummary[] {
  // A string snapshot is stable between renders; the objects are rebuilt
  // from it only when it changes.
  const key = useMessageQueue((s) => JSON.stringify(summarizeHeldMail(s.queues)))
  return useMemo(() => JSON.parse(key) as HeldMailSummary[], [key])
}

/**
 * Whether a Cowork session waits on the person: a prompt (see
 * useNeedsApproval) or mail from another session that waits for them. The
 * sidebar's yellow `wait` mark and its counts read this.
 */
export function useWaitingOnUser(sessionId: string | undefined): boolean {
  const approval = useNeedsApproval(sessionId)
  return useHeldMailCount(sessionId) > 0 || approval
}
