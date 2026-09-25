/* eslint-disable react-refresh/only-export-components */
import { useId, useMemo } from 'react'
import { cn } from '@/lib/utils'

/** Plot coordinates. The SVG stretches to its box, so x/y map to percentages. */
const W = 200
const H = 60
/** The last point stops short of the right edge so the dot is not clipped. */
const X_END = 192
/** Headroom above the peak, so the line never touches the top edge. */
const HEADROOM = 1.15
const PLOT_TOP = 4
const PLOT_H = H - PLOT_TOP

/** Catmull-Rom through every point, so the curve still passes through the data. */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return ''
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    // Clamp the control points' y into the plot: overshoot on a steep step
    // would otherwise draw the line below zero.
    const cy = (v: number) => Math.min(H, Math.max(0, v))
    d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${cy(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${cy(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return d
}

/**
 * Point positions for a series on a zero-based scale: the baseline is always
 * zero so two charts of the same unit compare by height.
 */
export function chartPoints(series: number[]): Array<[number, number]> {
  const n = series.length
  if (n === 0) return []
  const max = Math.max(...series, 0) * HEADROOM || 1
  return series.map((v, i) => [
    n === 1 ? X_END : (i * X_END) / (n - 1),
    H - (Math.max(0, v) / max) * PLOT_H,
  ])
}

/**
 * A small area chart for a live series (the design's `.lchart`): a smooth
 * line, a soft fill, dashed quarter grid lines, and a pulsing dot on the most
 * recent value. The dot is positioned from the same coordinates as the path,
 * so it sits exactly on the line end at any size.
 *
 * `compact` drops the frame, grid and captions for inline sparklines.
 * `off` greys the chart and hides the dot for a source that is not running.
 */
export function LiveChart({
  series,
  color = 'var(--success)',
  label,
  format = (v) => String(Math.round(v)),
  windowLabel,
  compact = false,
  off = false,
  className,
  plotClassName,
  ariaLabel,
  peakLabel = 'peak',
  avgLabel = 'avg',
}: {
  series: number[]
  /** Any CSS colour; the line, fill and dot all take it. */
  color?: string
  /** Caption over the plot, e.g. "calls / min". */
  label?: string
  format?: (value: number) => string
  /** Caption at the end of the footer, e.g. "last 20 min". */
  windowLabel?: string
  compact?: boolean
  off?: boolean
  className?: string
  plotClassName?: string
  ariaLabel?: string
  peakLabel?: string
  avgLabel?: string
}) {
  // React's ids carry ':' or '«»', which a `url(#...)` reference cannot hold.
  const gradientId = `lc${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const pts = useMemo(() => chartPoints(series), [series])
  const line = useMemo(() => smoothPath(pts), [pts])
  const last = pts[pts.length - 1]
  const current = series[series.length - 1]
  const hasData = !off && series.length > 0
  const peak = hasData ? Math.max(...series) : undefined
  const avg = hasData
    ? series.reduce((a, b) => a + b, 0) / series.length
    : undefined
  const dash = '—'

  return (
    <div
      data-slot="live-chart"
      data-off={off || undefined}
      role="img"
      aria-label={
        ariaLabel ??
        (hasData
          ? `${label ?? ''} ${format(current)}`.trim()
          : `${label ?? ''} ${dash}`.trim())
      }
      style={{ ['--c' as string]: off ? 'var(--subtle-foreground)' : color }}
      className={cn('flex flex-col gap-1.5', className)}
    >
      {!compact && (
        <div className="flex items-baseline justify-between text-[11.5px] text-muted-foreground">
          <span>{label}</span>
          <b className="text-[15px] font-semibold text-foreground tabular-nums motion-safe:animate-fade-in" key={hasData ? format(current) : 'none'}>
            {hasData ? format(current) : dash}
          </b>
        </div>
      )}
      <div
        className={cn(
          'relative',
          compact
            ? 'h-[30px] w-24 overflow-visible'
            : 'h-16 overflow-hidden rounded-lg bg-[linear-gradient(to_bottom,transparent,color-mix(in_oklab,var(--c)_5%,transparent))] shadow-[inset_0_0_0_0.8px_var(--border)]',
          off && 'opacity-55',
          plotClassName
        )}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden
          className="absolute inset-0 size-full"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--c)', stopOpacity: 0.32 }} />
              <stop offset="1" style={{ stopColor: 'var(--c)', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {!compact && (
            <g>
              {[15, 30, 45].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2={W}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth="1"
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          )}
          {line && (
            <>
              <path
                d={`${line} L${last[0].toFixed(1)},${H} L0,${H} Z`}
                fill={`url(#${gradientId})`}
              />
              <path
                d={line}
                fill="none"
                stroke="var(--c)"
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>
        {hasData && last && (
          <span
            data-slot="live-chart-dot"
            aria-hidden
            className="absolute -mt-1 -ml-1 size-2 rounded-full bg-[var(--c)] shadow-[0_0_0_2px_var(--card)]"
            style={{
              left: `${(last[0] / W) * 100}%`,
              top: `${(last[1] / H) * 100}%`,
            }}
          >
            <span className="absolute inset-0 rounded-full bg-[var(--c)] motion-safe:animate-ping" />
          </span>
        )}
      </div>
      {compact ? null : (
        <div className="flex gap-3.5 text-[11.5px] text-muted-foreground">
          <span>
            {peakLabel}{' '}
            <b className="font-medium text-fg-2 tabular-nums">
              {peak === undefined ? dash : format(peak)}
            </b>
          </span>
          <span>
            {avgLabel}{' '}
            <b className="font-medium text-fg-2 tabular-nums">
              {avg === undefined ? dash : format(avg)}
            </b>
          </span>
          {windowLabel && <span className="ml-auto">{windowLabel}</span>}
        </div>
      )}
    </div>
  )
}
