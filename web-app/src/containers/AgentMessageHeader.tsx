/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkPane } from '@/hooks/useCoworkPane'
import { AgentReplyForm } from '@/containers/AgentReplyForm'
import type { AgentMessageAttribution } from '@/types/coworkSession'

/** Reads `metadata.agentMessage` defensively: metadata is untyped. */
export function agentMessageOf(
  metadata: unknown
): AgentMessageAttribution | null {
  const raw = (metadata as { agentMessage?: unknown } | undefined)?.agentMessage
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (
    typeof m.sessionId !== 'string' ||
    typeof m.displayName !== 'string' ||
    typeof m.messageId !== 'string'
  ) {
    return null
  }
  return {
    sessionId: m.sessionId,
    displayName: m.displayName,
    messageId: m.messageId,
    replyTo: typeof m.replyTo === 'string' ? m.replyTo : null,
  }
}

/**
 * The label on a transcript row that is mail from another agent session:
 * "Message from <name>", with a Reply that answers it through the mailbox.
 *
 * Takes the message's raw metadata so mounting it in the renderer is one line;
 * renders nothing for any other message.
 */
export function AgentMessageHeader({
  metadata,
  sessionId,
}: {
  metadata: unknown
  /** The receiving session; defaults to the Cowork session in view. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const currentId = useCoworkSessions((s) => s.currentId)
  // In a split pane the session in view is the pane's, not the selection.
  const paneSessionId = useCoworkPane()?.sessionId
  const [replying, setReplying] = useState(false)
  const [sent, setSent] = useState(false)
  const message = agentMessageOf(metadata)
  const receiver = sessionId ?? paneSessionId ?? currentId
  if (!message) return null

  return (
    <div data-testid="agent-message-header" className="mb-1 text-xs">
      <div className="flex items-center gap-2 opacity-80">
        <Mail size={12} aria-hidden className="shrink-0" />
        <span>{t('messaging:messageFrom', { name: message.displayName })}</span>
        {receiver && !replying && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs pointer-coarse:h-11"
            data-testid="agent-message-reply"
            aria-label={t('messaging:replyLabel', { name: message.displayName })}
            onClick={() => {
              setSent(false)
              setReplying(true)
            }}
          >
            {t('messaging:reply')}
          </Button>
        )}
        {sent && (
          <span role="status" data-testid="agent-message-reply-sent">
            {t('messaging:replySent')}
          </span>
        )}
      </div>
      {replying && receiver && (
        <AgentReplyForm
          sessionId={receiver}
          messageId={message.messageId}
          senderName={message.displayName}
          onDone={(ok) => {
            setReplying(false)
            setSent(ok)
          }}
        />
      )}
    </div>
  )
}
