import type { ReactNode } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export type RunSettingsException = { id: string; label: string; warn?: boolean }

type Props = {
  /** Mode, work profile, effort: each a control that names its own state. */
  children: ReactNode
  /** What differs from the default, named beside the trigger, never hidden. */
  exceptions: RunSettingsException[]
}

/**
 * One collapsed home for the settings that change how a run works, so the
 * composer row keeps to the folder, the request and Send. Anything that is not
 * at its default stays named beside the trigger as a chip: closing the group
 * must never hide a non-default setting.
 */
export function CoworkRunSettings({ children, exceptions }: Props) {
  const { t } = useTranslation()
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            data-testid="cowork-run-settings"
            aria-label={t('common:coworkRunSettings.label')}
            className="h-7 shrink-0 gap-1.5 px-2 text-xs font-medium text-muted-foreground pointer-coarse:h-11"
          >
            <SlidersHorizontal aria-hidden className="size-3.5 shrink-0" />
            <span>{t('common:coworkRunSettings.label')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={12}
          className="flex w-72 flex-col items-start gap-2 p-3"
        >
          <p className="text-xs font-medium text-muted-foreground">
            {t('common:coworkRunSettings.title')}
          </p>
          {children}
        </PopoverContent>
      </Popover>
      {exceptions.map((e) => (
        <span
          key={e.id}
          data-testid={`cowork-run-exception-${e.id}`}
          className={cn(
            'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium',
            e.warn
              ? 'border-warning/35 bg-warning-tint text-warning'
              : 'border-border text-muted-foreground'
          )}
        >
          {e.label}
        </span>
      ))}
    </>
  )
}
