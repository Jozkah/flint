/* eslint-disable react-refresh/only-export-components */
import { useMemo, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  ChartTable,
  ChartTip,
  niceMax,
  useCursor,
  useSlide,
} from './chartKit'

/** Plot coordinates. The SVG stretches to its box, so x/y map to percentages. */
const W = 200
const H = 60
/** Padding inside the plot, so the end dot and the zero line are never clipped. */
const X0 = 4
const X1 = 196
const TOP = 6
const ZERO = 54

/**
 * Point positions for a series on a zero-based scale whose top is a clean
 * number (see {@link niceMax}), so the top gridline can be labelled truthfully
 * and two charts of the same unit compare by height.
 */
export function chartPoints(
  series: number[],
  yMax?: number
): Array<[number, number]> {
  const n = series.length
  if (n === 0) return []
  const max = yMax ?? niceMax(Math.max(...series, 0))
  return series.map((v, i) => [
    n === 1 ? X1 : X0 + (i * (X1 - X0)) / (n - 1),
    ZERO - (Math.max(0, v) / max) * (ZERO - TOP),
  ])
}

/** What a chart needs to be read point by point: the words, in the user's language. */
export type ChartReadout = {
  /** The newest sample, e.g. "now". */
  now: string
  /** How long ago a sample was, e.g. "3 min ago". */
  ago: (count: number) => string
  /** The start of the window under the plot, e.g. "20 min ago". */
  windowStart: string
  /** Appended to a value in the tooltip, e.g. "calls". */
  unit?: string
}

/**
 * A small area chart for a live series: a straight-segment line, a flat
 * wash, solid hairline grid lines with the top one labelled, and a dot on the
 * most recent value. The dot is positioned from the same coordinates as the
 * path, so it sits exactly on the line end at any size. A new sample slides in.
 *
 * With `readout`, every point can be read: hover or arrow keys show the time
 * and value, and the samples can be listed as a table.
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
  readout,
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
  readout?: ChartReadout
}) {
  const n = series.length
  const yMax = niceMax(Math.max(...series, 0))
  const pts = useMemo(() => chartPoints(series, yMax), [series, yMax])
  const line = useMemo(
    () =>
      pts.length === 0
        ? ''
        : `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}`,
    [pts]
  )
  const last = pts[pts.length - 1]
  const current = series[n - 1]
  const hasData = !off && n > 0
  const peak = hasData ? Math.max(...series) : undefined
  const avg = hasData ? series.reduce((a, b) => a + b, 0) / n : undefined
  const dash = '—'
  const step = n > 1 ? (X1 - X0) / (n - 1) : 0

  const groupRef = useRef<SVGGElement>(null)
  const dotRef = useRef<HTMLSpanElement>(null)
  const pulse = useSlide(series.join(','), {
    group: groupRef,
    dot: dotRef,
    step,
    width: W,
    lastX: last?.[0] ?? X1,
  })
  const cursor = useCursor({ count: n, x0: X0, step, width: W })
  const readable = !compact && hasData && readout !== undefined
  const at = readable ? cursor.index : null
  const when = (i: number) =>
    readout ? (i === n - 1 ? readout.now : readout.ago(n - 1 - i)) : ''
  const summary =
    ariaLabel ??
    (hasData
      ? `${label ?? ''} ${format(current)}`.trim()
      : `${label ?? ''} ${dash}`.trim())

  const plot = (
    <div className="relative">
      <div
        {...(readable
          ? {
              role: 'img',
              'aria-label': `${summary}, ${peakLabel} ${format(peak ?? 0)}, ${avgLabel} ${format(avg ?? 0)}`,
              tabIndex: 0,
              ...cursor.handlers,
            }
          : { 'aria-hidden': true })}
        className={cn(
          'relative',
          compact
            ? 'h-[30px] w-24 overflow-visible'
            : 'h-16 overflow-hidden rounded-lg bg-[linear-gradient(to_bottom,transparent,color-mix(in_oklab,var(--c)_5%,transparent))] shadow-[inset_0_0_0_0.8px_var(--border)]',
          readable &&
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
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
          {!compact && (
            <g>
              {[TOP, (TOP + ZERO) / 2, ZERO].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2={W}
                  y1={y}
                  y2={y}
                  style={{ stroke: 'var(--border)', strokeWidth: 1 }}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          )}
          <g
            ref={groupRef}
            className="transition-transform duration-500 ease-expo motion-reduce:transition-none"
          >
            {line && last && (
              <>
                <path
                  d={`${line} L${last[0].toFixed(1)},${ZERO} L${pts[0][0].toFixed(1)},${ZERO} Z`}
                  style={{ fill: 'var(--c)', fillOpacity: 0.12 }}
                />
                <path
                  d={line}
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  style={{ stroke: 'var(--c)', strokeWidth: 2 }}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </g>
        </svg>
        {!compact && hasData && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0.5 left-1 text-[length:calc(var(--ui-font-base)*0.625)] text-muted-foreground tabular-nums"
          >
            {format(yMax)}
          </span>
        )}
        {at !== null && pts[at] && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-border"
              style={{ left: `${(pts[at][0] / W) * 100}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute -mt-1 -ml-1 size-2 rounded-full bg-[var(--c)] shadow-[0_0_0_2px_var(--card)]"
              style={{
                left: `${(pts[at][0] / W) * 100}%`,
                top: `${(pts[at][1] / H) * 100}%`,
              }}
            />
          </>
        )}
        {hasData && last && (
          <span
            ref={dotRef}
            data-slot="live-chart-dot"
            aria-hidden
            className="absolute -mt-1 -ml-1 size-2 rounded-full bg-[var(--c)] shadow-[0_0_0_2px_var(--card)] transition-[left,top] duration-500 ease-expo motion-reduce:transition-none"
            style={{
              left: `${(last[0] / W) * 100}%`,
              top: `${(last[1] / H) * 100}%`,
            }}
          >
            {pulse > 0 && (
              <span
                key={pulse}
                className="absolute inset-0 rounded-full bg-[var(--c)] motion-safe:animate-[ping_900ms_cubic-bezier(0,0,0.2,1)_1]"
              />
            )}
          </span>
        )}
      </div>
      {at !== null && pts[at] && readout && (
        <ChartTip
          left={(pts[at][0] / W) * 100}
          text={`${when(at)} · ${format(series[at])}${readout.unit ? ` ${readout.unit}` : ''}`}
        />
      )}
    </div>
  )

  return (
    <div
      data-slot="live-chart"
      data-off={off || undefined}
      {...(readable ? {} : { role: 'img', 'aria-label': summary })}
      style={{ ['--c' as string]: off ? 'var(--subtle-foreground)' : color }}
      className={cn('flex flex-col gap-1.5', className)}
    >
      {!compact && (
        <div className="flex items-baseline justify-between text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
          <span>{label}</span>
          <b className="text-[length:calc(var(--ui-font-base)*0.9375)] font-semibold text-foreground tabular-nums motion-safe:animate-fade-in" key={hasData ? format(current) : dash}>
            {hasData ? format(current) : dash}
          </b>
        </div>
      )}
      {plot}
      {readable && (
        <ChartTable
          rows={series
            .map((v, i): [string, string] => [when(i), format(v)])
            .reverse()}
        />
      )}
      {readable && readout && (
        <div className="flex justify-between text-[length:calc(var(--ui-font-base)*0.65625)] text-muted-foreground">
          <span>{readout.windowStart}</span>
          <span>{readout.now}</span>
        </div>
      )}
      {compact ? null : (
        <div className="flex items-baseline gap-3.5 text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
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
