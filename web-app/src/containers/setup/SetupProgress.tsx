import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { WizardStep } from '@/lib/setupFlow'

/** "Step n of m" and one segment per page of the setup wizard. */
export function SetupProgress({
  pages,
  currentIndex,
}: {
  pages: WizardStep[]
  currentIndex: number
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-4">
      <span
        className="text-xs font-medium tabular-nums text-muted-foreground"
        data-testid="setup-step-counter"
      >
        {t('setup:stepCounter', {
          current: currentIndex + 1,
          total: pages.length,
        })}
      </span>
      {/* Segments rather than dots: they read as distance covered,
          which is what a first-run flow needs to convey. */}
      <span className="flex items-center gap-1" aria-hidden>
        {pages.map((page, index) => (
          <span
            key={page.id}
            className={cn(
              'h-1 w-6 rounded-full motion-safe:transition-colors',
              index === currentIndex
                ? 'bg-primary'
                : index < currentIndex
                  ? 'bg-secondary-foreground'
                  : 'bg-track'
            )}
          />
        ))}
      </span>
    </div>
  )
}
