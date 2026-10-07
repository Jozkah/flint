import { useEffect, useRef, useState } from 'react'
import { animate, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

export type StatusMarkState =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'

const STROKE = 2
const DASHES = 8
const SPIN_MS = 1100
const ARC = 0.68
const IDLE = 0.3
const RADIUS = 12 - STROKE / 2 - 1
const CIRC = 2 * Math.PI * RADIUS
const PERIOD = CIRC / DASHES

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Ring dash pattern for a blend of dashed (mode 0) and solid arc (mode 1). */
function dashArray(mode: number, arc: number): string {
  const dash = IDLE * PERIOD + (arc * CIRC - IDLE * PERIOD) * mode
  const gap =
    (1 - IDLE) * PERIOD + ((1 - arc) * CIRC - (1 - IDLE) * PERIOD) * mode
  return `${Math.max(0, dash)} ${Math.max(0, gap)}`
}

type Target = { solid: boolean; indeterminate: boolean; arc: number }

function targetFor(
  status: StatusMarkState,
  progress: number | undefined
): Target {
  const solid = status === 'running' || status === 'done' || status === 'failed'
  const determinate = status === 'running' && typeof progress === 'number'
  const indeterminate = status === 'running' && !determinate
  const arc = indeterminate ? ARC : determinate ? clamp01(progress ?? 0) : 1
  return { solid, indeterminate, arc }
}

export interface StatusMarkProps {
  status: StatusMarkState
  /** 0-1 fills the running arc; omit for the indeterminate spinner. */
  progress?: number
  /** Pixel size of the mark. */
  size?: number
  /** Optional text next to the mark; struck through (drawn) once done. */
  label?: React.ReactNode
  /** Accessible name for the mark. Without it the mark is decorative. */
  ariaLabel?: string
  className?: string
  labelClassName?: string
}

/**
 * Step status mark. The ring morphs between a dashed pending ring, a spinning
 * or determinate arc, and a solid ring that draws a check or a cross.
 */
export function StatusMark({
  status,
  progress,
  size = 16,
  label,
  ariaLabel,
  className,
  labelClassName,
}: StatusMarkProps) {
  const systemReduced = useReducedMotion()
  const storeReduced = useInterfaceSettings((s) => s.reduceMotion)
  const reduced = Boolean(systemReduced) || storeReduced
  const ringRef = useRef<SVGCircleElement>(null)
  const geo = useRef({ mode: 0, arc: 1, travel: 0 })
  const [initial] = useState(() => {
    const t = targetFor(status, progress)
    return dashArray(t.solid ? 1 : 0, t.arc)
  })

  useEffect(() => {
    const ring = ringRef.current
    if (!ring) return
    const g = geo.current
    const t = targetFor(status, progress)
    const writeDash = () =>
      ring.setAttribute('stroke-dasharray', dashArray(g.mode, g.arc))
    const writeOff = () =>
      ring.setAttribute('stroke-dashoffset', String(g.travel))
    let raf = 0
    const stops: Array<{ stop: () => void }> = []

    if (reduced) {
      g.mode = t.solid ? 1 : 0
      g.arc = t.arc
      g.travel = 0
      writeDash()
      writeOff()
      return
    }

    if (g.mode === 0) g.arc = t.arc
    stops.push(
      animate(g.mode, t.solid ? 1 : 0, {
        duration: 0.3,
        ease: 'easeInOut',
        onUpdate: (v) => {
          g.mode = v
          writeDash()
        },
      }),
      animate(g.arc, t.arc, {
        duration: 0.3,
        ease: 'easeOut',
        onUpdate: (v) => {
          g.arc = v
          writeDash()
        },
      })
    )

    if (t.indeterminate) {
      let last = performance.now()
      const step = (now: number) => {
        g.travel -= (CIRC * (now - last)) / SPIN_MS
        last = now
        writeOff()
        raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    } else {
      const unit =
        typeof progress === 'number' && status === 'running' ? CIRC : PERIOD
      const to = Math.floor(g.travel / unit) * unit
      stops.push(
        animate(g.travel, to, {
          duration: 0.3,
          ease: 'easeOut',
          onUpdate: (v) => {
            g.travel = v
            writeOff()
          },
          onComplete: () => {
            g.travel = 0
            writeOff()
          },
        })
      )
    }
    return () => {
      cancelAnimationFrame(raf)
      stops.forEach((s) => s.stop())
    }
  }, [status, progress, reduced])

  const crossed = status === 'failed' || status === 'cancelled'
  const drawn = (on: boolean) =>
    cn(
      'fill-none stroke-current [stroke-dasharray:1_2]',
      'motion-safe:transition-[stroke-dashoffset,opacity] motion-safe:duration-200',
      on
        ? '[stroke-dashoffset:0] opacity-100'
        : '[stroke-dashoffset:1.05] opacity-0'
    )

  const svg = (
    <svg
      data-testid="status-mark"
      data-status={status}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={cn(
        'shrink-0 overflow-visible text-current',
        'motion-safe:transition-colors motion-safe:duration-200',
        status === 'done' && 'text-success',
        status === 'failed' && 'text-destructive',
        status === 'cancelled' && 'text-muted-foreground',
        label === undefined && className
      )}
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle
        cx={12}
        cy={12}
        r={RADIUS}
        stroke="none"
        className={cn(
          'fill-current motion-safe:transition-opacity motion-safe:duration-200',
          status === 'done' || status === 'failed'
            ? 'opacity-[0.06]'
            : 'opacity-0'
        )}
      />
      <circle
        ref={ringRef}
        data-part="ring"
        cx={12}
        cy={12}
        r={RADIUS}
        transform="rotate(-90 12 12)"
        fill="none"
        stroke="currentColor"
        strokeDasharray={initial}
        strokeDashoffset={0}
        className={cn(
          'motion-safe:transition-opacity motion-safe:duration-200',
          status === 'pending' ? 'opacity-55' : 'opacity-100'
        )}
      />
      <path
        data-part="check"
        d="M7.5 12.25 10.5 15.25 16.75 8.75"
        pathLength={1}
        className={drawn(status === 'done')}
      />
      <path
        data-part="cross"
        d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5"
        pathLength={1}
        className={drawn(crossed)}
      />
    </svg>
  )

  if (label === undefined) return svg
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center gap-2 align-middle leading-none',
        className
      )}
    >
      {svg}
      <span
        className={cn(
          'relative leading-tight',
          status === 'running' || status === 'failed'
            ? 'opacity-100'
            : 'opacity-60',
          labelClassName
        )}
      >
        {label}
        <span
          aria-hidden
          data-testid="status-mark-strike"
          data-drawn={status === 'done' ? 'true' : 'false'}
          className={cn(
            'pointer-events-none absolute inset-x-0 top-1/2 h-px origin-left -translate-y-1/2 bg-current',
            'motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out',
            status === 'done' ? 'scale-x-100' : 'scale-x-0'
          )}
        />
      </span>
    </span>
  )
}
