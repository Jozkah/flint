import { useCallback, useId } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { effortLabel, type EffortLevel } from '@/lib/modelEffort'

/**
 * A discrete bar for choosing how hard the model should think.
 *
 * Four stops rather than a continuous range, because the underlying setting is
 * four discrete levels — a continuous track would invite values that do not
 * exist. Built as a real slider rather than a row of buttons so it arrives
 * with the keyboard behaviour people expect from one: arrows step, Home and
 * End jump to the ends, and a screen reader hears a slider with a named
 * position rather than four unrelated controls.
 *
 * The caller decides which levels exist (see `supportedEffortLevels`) and
 * renders nothing at all when the provider honours none of them.
 */
export function ReasoningEffortSlider({
  levels,
  value,
  onChange,
  overridden,
  onReset,
  className,
}: {
  /** The stops to show, in order. Never empty. */
  levels: EffortLevel[]
  /** The current level, or null when the model's own default is in force. */
  value: EffortLevel | null
  onChange: (level: EffortLevel) => void
  /** Whether this chat has overridden the global setting. */
  overridden?: boolean
  /** Offered only while `overridden`; gives the setting back to the global. */
  onReset?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const labelId = useId()
  const index = value ? levels.indexOf(value) : -1

  const step = useCallback(
    (delta: number) => {
      if (!levels.length) return
      // From "model default", stepping up starts at the lowest level rather
      // than jumping into the middle of the range.
      const from = index === -1 ? (delta > 0 ? -1 : levels.length) : index
      const next = Math.min(Math.max(from + delta, 0), levels.length - 1)
      if (levels[next] !== value) onChange(levels[next])
    },
    [index, levels, onChange, value]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          event.preventDefault()
          step(1)
          break
        case 'ArrowLeft':
        case 'ArrowDown':
          event.preventDefault()
          step(-1)
          break
        case 'Home':
          event.preventDefault()
          onChange(levels[0])
          break
        case 'End':
          event.preventDefault()
          onChange(levels[levels.length - 1])
          break
        default:
          break
      }
    },
    [levels, onChange, step]
  )

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span id={labelId} className="text-xs text-main-view-fg/70">
          {t('common:reasoningEffort.label')}
        </span>
        <span className="flex items-center gap-1.5">
          {/* The current level, above the bar as in the reference. */}
          <span className="text-xs font-medium tabular-nums">
            {value
              ? effortLabel(value)
              : t('common:reasoningEffort.modelDefault')}
          </span>
          {overridden && onReset && (
            <button
              type="button"
              onClick={onReset}
              className="text-[11px] text-main-view-fg/50 underline-offset-2 hover:underline"
            >
              {t('common:reasoningEffort.reset')}
            </button>
          )}
        </span>
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-valuemin={1}
        aria-valuemax={levels.length}
        // 1-based so "1 of 4" reads naturally; absent while the model's own
        // default is in force, which is a real state and not level zero.
        {...(index >= 0 ? { 'aria-valuenow': index + 1 } : {})}
        aria-valuetext={
          value ? effortLabel(value) : t('common:reasoningEffort.modelDefault')
        }
        onKeyDown={onKeyDown}
        className="flex items-center gap-1 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {levels.map((level, at) => {
          const filled = index >= 0 && at <= index
          return (
            <button
              key={level}
              type="button"
              tabIndex={-1}
              aria-label={effortLabel(level)}
              aria-pressed={value === level}
              onClick={() => onChange(level)}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                filled ? 'bg-primary' : 'bg-main-view-fg/15',
                'hover:bg-primary/60'
              )}
            />
          )
        })}
      </div>
    </div>
  )
}
