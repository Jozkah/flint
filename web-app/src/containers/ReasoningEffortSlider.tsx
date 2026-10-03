import { useCallback, useId, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  clampEffort,
  effortLabel,
  type EffortChoice,
  type EffortLevel,
} from '@/lib/modelEffort'

/**
 * One continuous bar for choosing how hard the model should think.
 *
 * A single track with a dot at each stop and a thumb that snaps between them:
 * click or drag anywhere on the track. The stops are discrete because the
 * underlying setting is, so the thumb never rests between two. Built as a real
 * slider so it arrives with the keyboard behaviour people expect from one:
 * arrows step, Home and End jump to the ends, and a screen reader hears a
 * slider with a named position.
 *
 * The caller says which levels this model takes and which one it runs at when
 * none is chosen (see `effortProfile`); that one is marked "Recommended", and
 * is where the thumb rests while nothing has been chosen. A model that can be
 * told not to think gets one more stop in front of the levels: Off.
 */
export function ReasoningEffortSlider({
  levels,
  value,
  recommended = null,
  canDisable = false,
  onChange,
  overridden,
  onReset,
  className,
}: {
  /** The stops to show, in order. Never empty. */
  levels: EffortLevel[]
  /** The chosen stop, or null while the model's own default is in force. */
  value: EffortChoice | null
  /** The model's own default: shown until a level is chosen, and marked. */
  recommended?: EffortLevel | null
  /** The model can be told not to think: adds an Off stop at the start. */
  canDisable?: boolean
  onChange: (choice: EffortChoice) => void
  /** Whether this chat has overridden the global setting. */
  overridden?: boolean
  /** Offered only while `overridden`; gives the setting back to the global. */
  onReset?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const labelId = useId()
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const stops: EffortChoice[] = canDisable ? ['off', ...levels] : levels
  const count = stops.length
  const stopLabel = (stop: EffortChoice) =>
    stop === 'off' ? t('common:reasoningEffort.off') : effortLabel(stop)
  // A stored level this model does not take is shown as the one it would send.
  const chosen: EffortChoice | null =
    value === 'off'
      ? canDisable
        ? 'off'
        : null
      : value
        ? clampEffort(value, levels)
        : null
  // Until one is chosen the model runs at its own default, so that is shown.
  const fallback =
    recommended && levels.includes(recommended)
      ? recommended
      : levels[Math.floor(levels.length / 2)]
  const shown = chosen ?? fallback
  const index = stops.indexOf(shown)
  const recommendedAt = recommended ? stops.indexOf(recommended) : -1
  const centre = (at: number) => `${((at + 0.5) / count) * 100}%`

  const select = useCallback(
    (at: number) => {
      const next = stops[Math.min(Math.max(at, 0), count - 1)]
      // The default shown while nothing is chosen can be chosen too: that pins
      // it, so it no longer follows the model.
      if (next && (next !== shown || chosen === null)) onChange(next)
    },
    [count, stops, onChange, shown, chosen]
  )

  const selectAt = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      select(Math.floor(((clientX - rect.left) / rect.width) * count))
    },
    [count, select]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          event.preventDefault()
          select(index + 1)
          break
        case 'ArrowLeft':
        case 'ArrowDown':
          event.preventDefault()
          select(index - 1)
          break
        case 'Home':
          event.preventDefault()
          select(0)
          break
        case 'End':
          event.preventDefault()
          select(count - 1)
          break
        default:
          break
      }
    },
    [count, index, select]
  )

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-1.5">
          <span id={labelId} className="text-xs text-muted-foreground">
            {t('common:reasoningEffort.short')}
          </span>
          <span className="whitespace-nowrap text-xs font-medium tabular-nums">
            {stopLabel(shown)}
          </span>
        </span>
        {overridden && onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('common:reasoningEffort.reset')}
          </button>
        )}
      </div>

      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{t('common:reasoningEffort.faster')}</span>
        <span>{t('common:reasoningEffort.smarter')}</span>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-valuemin={1}
        aria-valuemax={count}
        // 1-based, so "1 of 4" reads naturally.
        aria-valuenow={index + 1}
        aria-valuetext={stopLabel(shown)}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          dragging.current = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
          selectAt(event.clientX)
        }}
        onPointerMove={(event) => {
          if (dragging.current) selectAt(event.clientX)
        }}
        onPointerUp={(event) => {
          dragging.current = false
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        }}
        onPointerCancel={() => {
          dragging.current = false
        }}
        data-testid="effort-track"
        className="relative h-6 cursor-pointer touch-none rounded-md bg-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {stops.map((stop, at) => (
          <span
            key={stop}
            aria-hidden
            data-testid={`effort-stop-${stop}`}
            style={{ left: centre(at) }}
            className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/35"
          />
        ))}
        <span
          aria-hidden
          data-testid="effort-thumb"
          style={{
            left: `calc(${(index / count) * 100}% + 2px)`,
            width: `calc(${100 / count}% - 4px)`,
          }}
          className="absolute inset-y-0.5 rounded bg-foreground/80 shadow-sm motion-safe:transition-[left] motion-safe:duration-150"
        />
      </div>

      <div className="relative h-4 text-[11px] text-muted-foreground">
        {recommendedAt >= 0 && (
          <span
            data-testid="effort-recommended"
            // Centred under its stop, but kept inside the bar at either end.
            style={
              recommendedAt === count - 1
                ? { right: 0 }
                : recommendedAt === 0
                  ? { left: 0 }
                  : { left: centre(recommendedAt) }
            }
            className={cn(
              'absolute top-0 whitespace-nowrap',
              recommendedAt > 0 && recommendedAt < count - 1 && '-translate-x-1/2'
            )}
          >
            {t('common:reasoningEffort.recommended')}
          </span>
        )}
      </div>
    </div>
  )
}
