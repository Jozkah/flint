import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { usePreviewSummary } from '@/hooks/usePreviewSummary'
import { recapDue, markLeft, recapTranscript } from '@/lib/coworkRecap'

/**
 * A short "while you were away" line, shown when the user comes back to a
 * session that changed while another one was open. One tool-less completion on
 * the transcript, made only by an engine on this machine that is idle; with no
 * model loaded (or a hosted provider) nothing is shown and nothing is sent.
 */
export function CoworkRecap({
  sessionId,
  running,
}: {
  sessionId: string
  running: boolean
}) {
  const { t } = useTranslation()
  const session = useCoworkSessions((s) => s.sessions.find((x) => x.id === sessionId))
  const updated = session?.updated
  // Decided once, on arrival: what changed since the user last left.
  const [due] = useState(() => recapDue(sessionId, updated))
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => () => markLeft(sessionId), [sessionId])
  const key = due && !running && updated ? `${sessionId}\u0000${updated}` : undefined
  const turns = session?.turns
  const getTranscript = useMemo(
    () => (turns ? () => recapTranscript(turns) : undefined),
    [turns]
  )
  const { summary } = usePreviewSummary(key, !!key, getTranscript)
  if (!due || dismissed || running || !summary) return null
  return (
    <div
      data-testid="cowork-recap"
      className="mb-2 flex items-start gap-2 rounded-md border-[0.8px] border-border bg-card px-3 py-2 text-sm text-secondary-foreground"
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">{t('common:run.recap')} </span>
        {summary}
      </span>
      <button
        type="button"
        aria-label={t('common:run.recapDismiss')}
        className="text-muted-foreground hover:text-foreground"
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
