/**
 * Moves mailbox envelopes into Cowork sessions (docs/SESSION_MESSAGING.md,
 * "Delivery"), and keeps the backend's delivery state in step with what
 * actually reached the model.
 *
 * Lifecycle of one envelope, as implemented here:
 *
 * - **Running recipient.** `mailbox_take_for_delivery` (queued -> delivered)
 *   and the envelope enters the session's queue ready. The runner drains the
 *   queue only at its safe boundaries.
 * - **Idle recipient.** `mailbox_pending` (no state change) and the envelope
 *   enters the queue held, shown as "Message from <name>". It is sent only
 *   when the user releases it, or when Automatic wake-ups is on and the
 *   session is the one in view.
 * - **Released** (held -> ready, by the user or a wake-up):
 *   `mailbox_take_for_delivery`.
 * - **Drained** (a ready message leaves the queue: the runner took it, or the
 *   route sent it as the next request): `mailbox_mark_read`. The model has it
 *   in context, so it must not come back on the next startup sweep.
 * - **Dismissed**: the card removes it and marks it read.
 * - **A run ends** with mail still ready: the mail is held again, so the end
 *   of a run never becomes a run the user did not start. Wake-ups may then
 *   release it again, subject to the loop guard.
 *
 * Nothing here reads or writes approvals, grants or policy.
 */
import {
  sessionMailbox,
  wrapForModel,
  queueIdFor,
  type MailEnvelope,
  type MailboxUpdatedPayload,
  type SessionMailbox,
} from '@/lib/sessionMailbox'
import {
  useMessageQueue,
  type QueuedMessage,
  type QueuedMessageSender,
} from '@/stores/message-queue-store'
import type { AgentMessageAttribution } from '@/types/coworkSession'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'

type DeliveryMailbox = Pick<
  SessionMailbox,
  'takeForDelivery' | 'pending' | 'markRead'
>

type QueueState = { queues: Record<string, QueuedMessage[]> }

/** The sender fields a transcript row carries, from a queued message's sender. */
export function agentAttribution(from: QueuedMessageSender): AgentMessageAttribution {
  return {
    sessionId: from.sessionId,
    displayName: from.displayName,
    messageId: from.messageId,
    replyTo: from.replyTo ?? null,
  }
}

export function envelopeToQueued(
  envelope: MailEnvelope,
  held: boolean
): QueuedMessage {
  return {
    id: queueIdFor(envelope.id),
    text: wrapForModel(envelope),
    createdAt: envelope.createdAt,
    held,
    from: {
      sessionId: envelope.from.sessionId,
      displayName: envelope.from.displayName,
      messageId: envelope.id,
      replyTo: envelope.replyTo ?? null,
      depth: envelope.depth,
    },
  }
}

const isRunning = (sid: string) => Boolean(useCoworkRun.getState().runs[sid])
const isKnownSession = (sid: string) =>
  useCoworkSessions.getState().sessions.some((s) => s.id === sid)
const queueOf = (sid: string) => useMessageQueue.getState().getQueue(sid)

export function createMailboxDelivery(
  mailbox: DeliveryMailbox = sessionMailbox
) {
  /** Envelopes that already left the queue: drained, dismissed or cleared. */
  const handed = new Set<string>()
  /** One backend exchange per session at a time, so dedupe sees settled state. */
  const chains = new Map<string, Promise<void>>()

  const serialize = (sid: string, work: () => Promise<void>) => {
    const next = (chains.get(sid) ?? Promise.resolve())
      .then(work)
      .catch((e) => console.warn(`[mailbox] delivery for ${sid} failed:`, e))
    chains.set(sid, next)
    return next
  }

  const isKnownEnvelope = (sid: string, messageId: string) =>
    handed.has(messageId) ||
    queueOf(sid).some((m) => m.from?.messageId === messageId)

  const ingest = (sid: string, envelopes: MailEnvelope[], held: boolean) => {
    for (const envelope of envelopes) {
      if (envelope.to?.sessionId && envelope.to.sessionId !== sid) continue
      if (isKnownEnvelope(sid, envelope.id)) continue
      useMessageQueue.getState().enqueue(sid, envelopeToQueued(envelope, held))
    }
  }

  /**
   * Release this session's held mail if Automatic wake-ups allow it: the
   * setting is on, the session is the one in view, and it is idle. A reply
   * (`depth > 0`) is not auto-released while the session's last run was
   * itself a wake-up, so two sessions cannot wake each other in a loop.
   */
  const applyAutoWake = (sid: string) => {
    const { autoWake, lastRunWasWake } = useSessionMessaging.getState()
    if (!autoWake[sid]) return
    if (useCoworkSessions.getState().currentId !== sid) return
    if (isRunning(sid)) return
    let released = false
    for (const m of queueOf(sid)) {
      if (!m.held || !m.from) continue
      if (m.from.depth > 0 && lastRunWasWake[sid]) continue
      useMessageQueue.getState().release(sid, m.id)
      released = true
    }
    if (released) useSessionMessaging.getState().markWakeRequested(sid)
  }

  const syncSession = (sid: string) =>
    serialize(sid, async () => {
      if (!isKnownSession(sid)) return
      if (isRunning(sid)) {
        const envelopes = await mailbox.takeForDelivery(sid)
        // The run may have ended while the backend answered: held, then.
        ingest(sid, envelopes, !isRunning(sid))
        if (!isRunning(sid)) applyAutoWake(sid)
      } else {
        const envelopes = await mailbox.pending(sid)
        ingest(sid, envelopes, true)
        applyAutoWake(sid)
      }
    })

  const onEvent = (payload: MailboxUpdatedPayload | undefined) => {
    const sid = payload?.sessionId
    if (!sid || !isKnownSession(sid)) return Promise.resolve()
    return syncSession(sid)
  }

  /** Mail received while the app was closed, for every local session. */
  const sweep = () =>
    Promise.all(
      useCoworkSessions.getState().sessions.map((s) => syncSession(s.id))
    ).then(() => undefined)

  const handleQueueChange = (state: QueueState, prev: QueueState) => {
    for (const sid of Object.keys(prev.queues)) {
      const before = prev.queues[sid] ?? []
      const after = state.queues[sid] ?? []
      if (before === after) continue
      const afterById = new Map(after.map((m) => [m.id, m]))
      const drained: string[] = []
      let released = false
      for (const m of before) {
        if (!m.from) continue
        const now = afterById.get(m.id)
        if (!now) {
          handed.add(m.from.messageId)
          if (!m.held) drained.push(m.from.messageId)
        } else if (m.held && !now.held) {
          released = true
        }
      }
      if (released) {
        void serialize(sid, async () => {
          const envelopes = await mailbox.takeForDelivery(sid)
          ingest(sid, envelopes, !isRunning(sid))
        })
      }
      if (drained.length > 0) {
        void mailbox
          .markRead(sid, drained)
          .catch((e) => console.warn('[mailbox] mark read failed:', e))
      }
    }
  }

  const handleRunsChange = (
    runs: Record<string, unknown>,
    prev: Record<string, unknown>
  ) => {
    for (const sid of Object.keys(runs)) {
      if (!prev[sid]) useSessionMessaging.getState().noteRunStarted(sid)
    }
    for (const sid of Object.keys(prev)) {
      if (runs[sid]) continue
      for (const m of queueOf(sid)) {
        if (m.from && !m.held) useMessageQueue.getState().hold(sid, m.id)
      }
      applyAutoWake(sid)
    }
  }

  const start = () => {
    const offQueue = useMessageQueue.subscribe((state, prev) =>
      handleQueueChange(state, prev)
    )
    const offRuns = useCoworkRun.subscribe((state, prev) => {
      if (state.runs !== prev.runs) handleRunsChange(state.runs, prev.runs)
    })
    const offFocus = useCoworkSessions.subscribe((state, prev) => {
      if (state.currentId && state.currentId !== prev.currentId) {
        applyAutoWake(state.currentId)
      }
    })
    const offSettings = useSessionMessaging.subscribe((state, prev) => {
      if (state.autoWake === prev.autoWake) return
      for (const sid of Object.keys(state.autoWake)) {
        if (!prev.autoWake[sid]) applyAutoWake(sid)
      }
    })
    return () => {
      offQueue()
      offRuns()
      offFocus()
      offSettings()
    }
  }

  return {
    start,
    sweep,
    onEvent,
    syncSession,
    applyAutoWake,
    handleQueueChange,
    handleRunsChange,
  }
}

let singleton: ReturnType<typeof createMailboxDelivery> | null = null

export function getMailboxDelivery() {
  singleton ??= createMailboxDelivery()
  return singleton
}
