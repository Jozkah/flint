import { FileDiff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * "N files ready for review", at the end of the conversation once a run has
 * stopped, with the way to the Changes panel beside it.
 *
 * Counts only what the Changes rail already counts for this session, so it can
 * never disagree with the panel it opens.
 */
export function CoworkReviewReady({
  fileCount,
  additions,
  deletions,
  onReview,
}: {
  fileCount: number
  additions: number
  deletions: number
  onReview: () => void
}) {
  const { t } = useTranslation()
  if (fileCount <= 0) return null
  return (
    <section
      aria-label={t('common:coworkReview.ready', { count: fileCount })}
      data-testid="cowork-review-ready"
      className="mb-1.5 flex min-h-[38px] flex-wrap items-center gap-2.5 rounded-[10px] bg-muted py-1 pr-1.5 pl-3 text-[13px] shadow-[inset_0_0_0_0.8px_var(--border)] motion-safe:animate-rise-in"
    >
      <FileDiff className="size-4 shrink-0 text-fg-2" aria-hidden />
      <span className="font-semibold text-foreground">
        {t('common:coworkReview.ready', { count: fileCount })}
      </span>
      <span className="flex-1 font-mono text-[10.5px] tabular-nums">
        <span className="text-diff-add">+{additions}</span>{' '}
        <span className="text-diff-del">−{deletions}</span>
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 pointer-coarse:h-11"
        onClick={onReview}
        data-testid="cowork-review-ready-open"
      >
        {t('common:coworkReview.open')}
      </Button>
    </section>
  )
}

export default CoworkReviewReady
