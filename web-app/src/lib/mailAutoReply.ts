/**
 * A session that handled a message from another session answers it with its
 * final answer, unless the agent already replied itself.
 *
 * Without this a session asked "which chart library do you use?" would write
 * the answer in its own transcript and the asking session would wait for a
 * `send_message` that the model forgot or did not know to make. Only the
 * original request is answered this way, never a reply, so two sessions cannot
 * keep answering each other.
 *
 * Nothing here carries authority: the answer is ordinary mailbox text, framed
 * as untrusted data on the receiving side like any other message.
 */
import { sessionMailbox, type SessionMailbox } from '@/lib/sessionMailbox'
import type { QueuedMessageSender } from '@/stores/message-queue-store'

type ReplyMailbox = Pick<SessionMailbox, 'autoReply'>

/** The mail a run took in, kept until the run ends. */
export function createMailLedger() {
  const taken = new Map<string, QueuedMessageSender>()
  return {
    note(from: QueuedMessageSender | undefined) {
      if (from) taken.set(from.messageId, from)
    },
    /** What still wants an answer: requests, not replies. */
    unanswered(): QueuedMessageSender[] {
      return [...taken.values()].filter((m) => (m.depth ?? 0) === 0)
    },
  }
}

export type MailLedger = ReturnType<typeof createMailLedger>

/** The words of the last assistant message, or '' when there is none. */
export function finalAnswerText(
  messages: readonly { role?: string; parts?: readonly { type?: string; text?: string }[] }[]
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const text = (message.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

export async function answerMail(
  sessionId: string,
  mail: readonly QueuedMessageSender[],
  text: string,
  mailbox: ReplyMailbox = sessionMailbox
): Promise<number> {
  if (!text.trim()) return 0
  let sent = 0
  for (const m of mail) {
    try {
      const receipt = await mailbox.autoReply({
        fromSessionId: sessionId,
        replyTo: m.messageId,
        text,
      })
      if (receipt) sent += 1
    } catch (e) {
      // The sender may be gone, or a limit may hold. The answer is still in
      // this session's own transcript.
      console.warn('[mailbox] automatic reply failed:', e)
    }
  }
  return sent
}
