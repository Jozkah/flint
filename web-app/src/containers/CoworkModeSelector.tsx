import { ChevronDown, Diamond, ShieldCheck, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  COWORK_MODES,
  modeDescriptionKey,
  modeLabelKey,
  type CoworkMode,
} from '@/lib/coworkMode'

const ICONS: Record<CoworkMode, typeof Diamond> = {
  review: Diamond,
  ask: ShieldCheck,
  auto: Zap,
}

type Props = {
  mode: CoworkMode
  onChange: (mode: CoworkMode) => void
}

/**
 * Which of the three modes this session is in, stated rather than implied.
 *
 * The control it replaces was an icon whose meaning was carried entirely by
 * whether it looked pressed — so the difference between "this will edit my
 * repository" and "this will not" was a fill colour. The mode is always named
 * here, and every option carries the sentence that says what it does, because
 * a person choosing Autonomous should be choosing it deliberately.
 */
export function CoworkModeSelector({ mode, onChange }: Props) {
  const { t } = useTranslation()
  const Icon = ICONS[mode]

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t('common:coworkMode.label')}
            className={cn(
              'shrink-0 gap-1',
              // Autonomous is the mode that can change things without asking,
              // so it is the one that does not sit quietly in the row.
              mode === 'auto' ? 'text-brand-text' : 'text-muted-foreground'
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span>{t(modeLabelKey(mode))}</span>
            <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {COWORK_MODES.map((option) => {
            const OptionIcon = ICONS[option]
            return (
              <DropdownMenuItem
                key={option}
                // `menuitemradio`, not a plain item: these are three states of
                // one setting, and a screen reader should hear which is on
                // without being told separately.
                role="menuitemradio"
                aria-checked={option === mode}
                onSelect={() => onChange(option)}
                className="items-start gap-2"
              >
                <OptionIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {t(modeLabelKey(option))}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(modeDescriptionKey(option))}
                  </span>
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The row is quiet by design, so the change itself is announced. */}
      <span aria-live="polite" className="sr-only">
        {t(modeLabelKey(mode))}
      </span>
    </>
  )
}
