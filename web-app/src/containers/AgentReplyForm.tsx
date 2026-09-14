import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { sessionMailbox, toMailboxError } from '@/lib/sessionMailbox'

/**
 * An inline reply to one mailbox message, sent through `mailbox_reply` as the
 * user (`origin: "user"`). Refusals come back typed and are shown in place.
 */
export function AgentReplyForm({
  sessionId,
  messageId,
  senderName,
  onDone,
}: {
  /** The session replying: the one the message was sent to. */
  sessionId: string
  messageId: string
  senderName: string
  onDone: (sent: boolean) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldId = useId()
  const errorId = useId()

  const send = async () => {
    if (sending || !text.trim()) return
    setSending(true)
    setError(null)
    try {
      await sessionMailbox.reply({
        fromSessionId: sessionId,
        replyTo: messageId,
        text,
      })
      onDone(true)
    } catch (e) {
      const err = toMailboxError(e)
      setError(t(`messaging:errors.${err.code}`))
      setSending(false)
    }
  }

  return (
    <div className="mt-1 space-y-1" data-testid="agent-reply-form">
      <label htmlFor={fieldId} className="sr-only">
        {t('messaging:replyLabel', { name: senderName })}
      </label>
      <textarea
        id={fieldId}
        data-testid="agent-reply-text"
        className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs"
        rows={3}
        autoFocus
        value={text}
        placeholder={t('messaging:replyPlaceholder')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone(false)
          }
        }}
      />
      {error && (
        <div
          id={errorId}
          role="alert"
          data-testid="agent-reply-error"
          className="text-destructive"
        >
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-7"
          data-testid="agent-reply-send"
          disabled={sending || !text.trim()}
          onClick={() => void send()}
        >
          {t('messaging:sendReply')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          data-testid="agent-reply-cancel"
          onClick={() => onDone(false)}
        >
          {t('messaging:cancel')}
        </Button>
      </div>
    </div>
  )
}
