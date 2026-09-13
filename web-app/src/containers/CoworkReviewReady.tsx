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
      className="my-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
    >
      <FileDiff className="size-4 shrink-0 text-ink-2" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">
          {t('common:coworkReview.ready', { count: fileCount })}
        </span>
        <span className="font-mono text-xs tabular-nums">
          <span className="text-success">+{additions}</span>{' '}
          <span className="text-destructive">-{deletions}</span>
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={onReview}
        data-testid="cowork-review-ready-open"
      >
        {t('common:coworkReview.open')}
      </Button>
    </section>
  )
}

export default CoworkReviewReady
