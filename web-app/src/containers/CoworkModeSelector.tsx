import { Check, ChevronDown, Diamond, ShieldCheck, ShieldOff, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  COWORK_MODES,
  modeDescriptionKey,
  modeLabelKey,
  modeShortLabelKey,
  type CoworkMode,
} from '@/lib/coworkMode'

const ICONS: Record<CoworkMode, typeof Diamond> = {
  review: Diamond,
  ask: ShieldCheck,
  auto: Zap,
  bypass: ShieldOff,
}

type Props = {
  mode: CoworkMode
  onChange: (mode: CoworkMode) => void
  /** `pill` in a split-pane composer row; `quiet` under the composer. */
  variant?: 'pill' | 'quiet'
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
export function CoworkModeSelector({ mode, onChange, variant = 'pill' }: Props) {
  const quiet = variant === 'quiet'
  const { t } = useTranslation()
  const Icon = ICONS[mode]

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={quiet ? 'ghost' : 'outline'}
            size="xs"
            aria-label={t('common:coworkMode.label')}
            title={t(modeLabelKey(mode))}
            data-testid="cowork-mode-selector"
            className={cn(
              quiet
                ? 'h-7 shrink-0 gap-1.5 px-2 text-xs font-medium pointer-coarse:h-11'
                : // 30px, the height of every context control in the split pane.
                  'h-[30px] shrink-0 gap-1.5 px-2.5 text-xs font-medium pointer-coarse:h-11',
              // Autonomous is the mode that can change things without asking,
              // so it is the one that does not sit quietly in the row. Warning,
              // not the accent: the accent means selected.
              mode === 'auto' || mode === 'bypass'
                ? quiet
                  ? 'text-warning hover:text-warning'
                  : 'border-warning/35 bg-warning-tint text-warning'
                : quiet
                  ? 'text-muted-foreground'
                  : 'text-secondary-foreground'
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span>{t(modeShortLabelKey(mode))}</span>
            {!quiet && (
              <ChevronDown
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground"
              />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 p-1.5">
          <DropdownMenuLabel>{t('common:coworkMode.label')}</DropdownMenuLabel>
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
                className={cn(
                  'items-start gap-2.5 px-2.5 py-2',
                  option === mode && 'bg-accent'
                )}
              >
                <OptionIcon
                  aria-hidden
                  className={cn(
                    'mt-px size-4 shrink-0',
                    option === 'auto' || option === 'bypass'
                      ? 'text-warning'
                      : 'text-secondary-foreground'
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="text-[13px] font-medium">
                    {t(modeLabelKey(option))}
                  </span>
                  <span className="text-xs leading-[1.4] text-muted-foreground">
                    {t(modeDescriptionKey(option))}
                  </span>
                </span>
                {option === mode ? (
                  <Check
                    aria-hidden
                    className="size-4 shrink-0 text-foreground"
                  />
                ) : null}
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
