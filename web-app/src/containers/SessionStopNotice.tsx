import { OctagonX } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { SessionStopNotice as SessionStopNoticeData } from '@/types/coworkSession'

/**
 * "Stopped by <session> — reason: … (approved in <session>)".
 *
 * The name and the reason come from another session (its title, and what its
 * agent wrote), so they are placed as text nodes and never interpolated into
 * translated strings or parsed as markdown.
 */
export function SessionStopNotice({ notice }: { notice: SessionStopNoticeData }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="session-stop-notice"
      data-request-id={notice.requestId}
      data-from-session={notice.fromSessionId}
      className="mt-2 flex items-start gap-2 rounded-md border border-line-strong bg-card px-3 py-2 text-xs text-ink-2"
      role="note"
    >
      <OctagonX size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      <p className="min-w-0 whitespace-pre-wrap break-words">
        <span>{t('messaging:stopNotice.stoppedBy')} </span>
        <span data-testid="session-stop-notice-from" className="font-medium text-foreground">
          {notice.fromName}
        </span>
        <span> — {t('messaging:stopNotice.reason')} </span>
        <span data-testid="session-stop-notice-reason">{notice.reason}</span>
        <span> ({t('messaging:stopNotice.approvedIn')} </span>
        <span>{notice.fromName}</span>
        <span>)</span>
      </p>
    </div>
  )
}
