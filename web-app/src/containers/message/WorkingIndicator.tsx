import { useTranslation } from '@/i18n/react-i18next-compat'
import { useConversationPane } from '@/hooks/useConversationPane'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

/**
 * The one line the quiet transcript views show while the agent works, in
 * place of the "N steps" disclosure. A polite live region, so a screen reader
 * hears that work started without being interrupted by it.
 */
export function WorkingIndicator() {
  const { t } = useTranslation()
  const threadId = useConversationPane()?.threadId
  // A run stopped on a question is not "working": say who it waits for, so a
  // question the person has not seen cannot look like a hang.
  const waiting = useToolApprovalRequests((s) =>
    Object.values(s.pending ?? {}).some((e) => e?.threadId === threadId) ||
    Object.values(s.queued ?? {}).some((l) =>
      l.some((e) => e.threadId === threadId)
    )
  )
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="transcript-working"
      className="mb-2.5 text-xs text-muted-foreground motion-safe:animate-pulse"
    >
      {waiting
        ? t('chat:transcriptView.waitingApproval')
        : t('chat:transcriptView.workingEllipsis')}
    </div>
  )
}
