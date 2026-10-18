import { useId, useState } from 'react'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useMessageQueue, type QueuedMessage } from '@/stores/message-queue-store'
import { sessionMailbox, unwrapForDisplay } from '@/lib/sessionMailbox'
import { AgentReplyForm } from '@/containers/AgentReplyForm'

/**
 * One held message from another agent session.
 *
 * The text is shown as plain text -- never rendered as markdown, never
 * interpreted -- because it is untrusted: another agent wrote it. The user
 * chooses: reply to the sender, let this session's agent respond (releases it
 * into the queue), or dismiss it (removed and marked read).
 */
export function AgentMessageCard({
  sessionId,
  message,
}: {
  sessionId: string
  message: QueuedMessage & { from: NonNullable<QueuedMessage['from']> }
}) {
  const { t } = useTranslation()
  const [replying, setReplying] = useState(false)
  const [sent, setSent] = useState(false)
  const titleId = useId()
  const name = message.from.displayName

  const dismiss = () => {
    useMessageQueue.getState().removeMessage(sessionId, message.id)
    void sessionMailbox
      .markRead(sessionId, [message.from.messageId])
      .catch((e) => console.warn('[mailbox] mark read failed:', e))
  }

  const at = new Date(message.createdAt)
  return (
    <section
      aria-labelledby={titleId}
      data-testid={`agent-message-${message.from.messageId}`}
      className="space-y-2 rounded-lg border border-border bg-card px-3.5 py-3 text-sm"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Mail size={14} aria-hidden className="shrink-0" />
        <h3 id={titleId} className="font-medium text-foreground">
          {t('messaging:messageFrom', { name })}
        </h3>
        <time
          dateTime={at.toISOString()}
          title={at.toLocaleString()}
          className="ml-auto shrink-0 text-xs tabular-nums"
        >
          {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </div>
      {message.from.hold && (
        <p
          data-testid="held-mail-chain-limit"
          className="rounded-md bg-warning/10 px-2 py-1 text-xs text-foreground"
        >
          {t('messaging:chainLimitHeld')}
        </p>
      )}
      <p
        data-testid="agent-message-text"
        dir="auto"
        className="whitespace-pre-wrap break-words"
      >
        {unwrapForDisplay(message.text)}
      </p>
      {sent && (
        <div role="status" data-testid="agent-message-reply-sent">
          {t('messaging:replySent')}
        </div>
      )}
      {replying ? (
        <AgentReplyForm
          sessionId={sessionId}
          messageId={message.from.messageId}
          senderName={name}
          onDone={(ok) => {
            setReplying(false)
            setSent(ok)
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            data-testid="agent-message-reply"
            aria-label={t('messaging:replyLabel', { name })}
            onClick={() => {
              setSent(false)
              setReplying(true)
            }}
          >
            {t('messaging:reply')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            data-testid="agent-message-release"
            onClick={() =>
              useMessageQueue.getState().release(sessionId, message.id)
            }
          >
            {t('messaging:letAgentRespond')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            data-testid="agent-message-dismiss"
            onClick={dismiss}
          >
            {t('messaging:dismiss')}
          </Button>
        </div>
      )}
    </section>
  )
}
