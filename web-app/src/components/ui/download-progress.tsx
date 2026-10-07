import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const ONES = Array.from({ length: 101 }, (_, n) => String(n % 10))
const TENS = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const HUNDREDS = ['', '1']

function Column({
  rows,
  index,
  testId,
}: {
  rows: string[]
  index: number
  testId: string
}) {
  return (
    <span className="dlp-num" aria-hidden>
      <span
        className="dlp-col"
        data-testid={testId}
        style={{ transform: `translateY(${-index}em)` }}
      >
        {rows.map((row, i) => (
          <span key={i}>{row}</span>
        ))}
      </span>
    </span>
  )
}

export type DownloadProgressProps = {
  /** 0..100. Only ever moves forward while mounted. */
  percent: number
  /** Whole transfer finished: green bar, status reads `readyLabel`. */
  done?: boolean
  /** Nothing is moving (verifying, installing): no stripes, no light. */
  idle?: boolean
  /** Replaces the odometer, e.g. `Verifying…`. */
  label?: ReactNode
  /** Right of the percentage, e.g. `1.2 / 4.9 GB`. */
  sizeText?: ReactNode
  /** Under the bar, right, e.g. `38 MB/s · 12s left`. */
  rateText?: ReactNode
  downloadingLabel?: string
  readyLabel?: string
  /** Hide the line under the bar (tight spaces). */
  compact?: boolean
  className?: string
}

/** A download bar with moving stripes, a light at the leading edge and a forward-only odometer. */
export function DownloadProgress({
  percent,
  done = false,
  idle = false,
  label,
  sizeText,
  rateText,
  downloadingLabel = 'Downloading…',
  readyLabel = 'Ready',
  compact = false,
  className,
}: DownloadProgressProps) {
  const clamped = Math.min(
    100,
    Math.max(0, Number.isFinite(percent) ? percent : 0)
  )
  const [best, setBest] = useState(clamped)
  if (clamped > best) setBest(clamped)
  const shown = done ? 100 : Math.max(best, clamped)
  const whole = Math.floor(shown)
  const state = done ? 'done' : idle ? 'idle' : 'running'

  return (
    <div
      className={cn(
        'dlp-root flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground',
        className
      )}
      data-state={state}
    >
      <div className="flex items-center justify-between gap-2">
        {label ?? (
          <span
            data-testid="download-percent"
            className="inline-flex items-baseline tabular-nums"
          >
            <span className="sr-only">{`${whole}%`}</span>
            <Column
              rows={HUNDREDS}
              index={whole >= 100 ? 1 : 0}
              testId="dlp-hundreds"
            />
            <Column
              rows={TENS}
              index={Math.floor(whole / 10)}
              testId="dlp-tens"
            />
            <Column rows={ONES} index={whole} testId="dlp-ones" />
            <span aria-hidden>%</span>
          </span>
        )}
        {sizeText && (
          <span className="shrink-0 truncate tabular-nums">{sizeText}</span>
        )}
      </div>
      <div
        className="dlp-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={whole}
      >
        <i
          className="dlp-fill"
          data-testid="dlp-fill"
          style={{ transform: `translateX(-${100 - shown}%)` }}
        />
        <b className="dlp-sheen" aria-hidden style={{ left: `${shown}%` }} />
      </div>
      {!compact && (
        <div className="flex items-center justify-between gap-2">
          <span className="dlp-status" aria-live="polite">
            <span className="dlp-a" aria-hidden={done}>
              {downloadingLabel}
            </span>
            <span className="dlp-b" aria-hidden={!done}>
              {readyLabel}
            </span>
          </span>
          {rateText && (
            <span className="shrink-0 truncate tabular-nums">{rateText}</span>
          )}
        </div>
      )}
    </div>
  )
}
