import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ReasoningEffortSlider } from '@/containers/ReasoningEffortSlider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  clampEffort,
  effortLabel,
  type EffortChoice,
  type EffortLevel,
} from '@/lib/modelEffort'

/**
 * The reasoning effort, docked under the composer beside the model: a quiet
 * button naming the level, which opens the stepped bar. Rendered only for a
 * model that honours an effort (see `supportedEffortLevels`).
 */
export function ComposerEffort({
  levels,
  value,
  recommended = null,
  canDisable = false,
  overridden,
  onChange,
  onReset,
}: {
  levels: EffortLevel[]
  value: EffortChoice | null
  /** The model's own default: named here until a level is chosen. */
  recommended?: EffortLevel | null
  /** The model can be told not to think: the bar gets an Off stop. */
  canDisable?: boolean
  overridden?: boolean
  onChange: (choice: EffortChoice) => void
  onReset?: () => void
}) {
  const { t } = useTranslation()
  // Until one is chosen the model runs at its own default, so that is what
  // the button names.
  const chosen: EffortChoice | null =
    value === 'off'
      ? canDisable
        ? 'off'
        : null
      : value
        ? clampEffort(value, levels)
        : null
  const shown: EffortChoice =
    chosen ??
    (recommended && levels.includes(recommended)
      ? recommended
      : levels[Math.floor(levels.length / 2)])
  const label =
    shown === 'off' ? t('common:reasoningEffort.off') : effortLabel(shown)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="composer-effort"
          aria-label={`${t('common:reasoningEffort.label')}: ${label}`}
          // The same quiet look as the model name beside it: text only, no box,
          // a faint wash on hover.
          className="flex h-7 shrink-0 items-center rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors duration-150 hover:bg-hover-row data-[state=open]:bg-hover-row focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-64 p-3">
        <ReasoningEffortSlider
          levels={levels}
          value={value}
          recommended={recommended}
          canDisable={canDisable}
          overridden={overridden}
          onChange={onChange}
          onReset={onReset}
        />
      </PopoverContent>
    </Popover>
  )
}
