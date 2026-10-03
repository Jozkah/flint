import { memo, useId, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

type EnableToolsCardProps = {
  modelName: string
  /** Absent outside a conversation: only "Always enable" is offered then. */
  onEnableThread?: () => void
  onEnableAlways: () => void
}

/**
 * Asked under a reply whose model tried to use a tool while tool calls are off
 * for it. Laid out as a tool approval is: the narrow answer is the filled one,
 * the broader one sits behind "More options" with what it means.
 */
export const EnableToolsCard = memo(
  ({ modelName, onEnableThread, onEnableAlways }: EnableToolsCardProps) => {
    const { t } = useTranslation()
    const [dismissed, setDismissed] = useState(false)
    const [moreOpen, setMoreOpen] = useState(!onEnableThread)
    const titleId = useId()
    const moreId = useId()

    if (dismissed) return null

    return (
      <section
        data-testid="enable-tools-card"
        data-slot="approval-panel"
        aria-labelledby={titleId}
        className="mt-2 flex min-w-0 flex-col gap-2.5 rounded-lg border border-border p-3 text-foreground sm:p-3.5"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">
          <span className="font-medium">
            {t('common:modelCapability.toolsOff')}
          </span>
          <Chip tone="warn">{modelName}</Chip>
        </div>
        <h3
          id={titleId}
          className="min-w-0 text-[15px] leading-snug font-semibold wrap-break-word text-foreground"
        >
          {t('common:modelCapability.toolsOffTitle')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t('common:modelCapability.warning')}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {onEnableThread && (
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              data-testid="enable-tools-more-options"
              className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11"
              onClick={() => setMoreOpen((open) => !open)}
            >
              {t('tools:toolApproval.moreOptions')}
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  'size-3 motion-safe:transition-transform',
                  moreOpen && 'rotate-180'
                )}
              />
            </button>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              type="button"
              data-scope="deny"
              className="min-w-20 border-destructive/40 pointer-coarse:h-11"
              onClick={() => setDismissed(true)}
            >
              {t('common:modelCapability.notNow')}
            </Button>
            {onEnableThread && (
              <Button
                size="sm"
                type="button"
                data-scope="allow-thread"
                data-primary="true"
                className="min-w-24 pointer-coarse:h-11"
                onClick={onEnableThread}
              >
                {t('common:modelCapability.enableThread')}
              </Button>
            )}
          </div>
          {moreOpen && (
            <ul
              id={moreId}
              className="flex w-full min-w-0 flex-col overflow-hidden rounded-md border border-border"
            >
              <li className="flex">
                <button
                  type="button"
                  data-scope="allow-always"
                  aria-describedby={`${moreId}-always`}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left transition-colors outline-hidden hover:bg-hover-row focus-visible:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset pointer-coarse:min-h-11"
                  onClick={onEnableAlways}
                >
                  <b className="text-[13px] font-medium text-foreground">
                    {t('common:modelCapability.enableAlways')}
                  </b>
                  <Chip tone="warn">{t('permissions:scope.broader')}</Chip>
                  <span
                    id={`${moreId}-always`}
                    className="w-full text-xs leading-snug text-muted-foreground"
                  >
                    {t('common:modelCapability.enableAlwaysExplanation')}
                  </span>
                </button>
              </li>
            </ul>
          )}
        </div>
      </section>
    )
  }
)
EnableToolsCard.displayName = 'EnableToolsCard'
