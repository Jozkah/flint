import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The one line the quiet transcript views show while the agent works, in
 * place of the "N steps" disclosure. A polite live region, so a screen reader
 * hears that work started without being interrupted by it.
 */
export function WorkingIndicator() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="transcript-working"
      className="mb-2.5 text-xs text-muted-foreground motion-safe:animate-pulse"
    >
      {t('chat:transcriptView.workingEllipsis')}
    </div>
  )
}
