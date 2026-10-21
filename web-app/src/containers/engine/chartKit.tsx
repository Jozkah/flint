import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'

/**
 * Pieces shared by Flint's small live charts (the MCP call sparklines and the
 * System Monitor area charts): a clean scale maximum, the point under the
 * pointer or keyboard cursor, the slide that brings a new sample in, and the
 * tooltip and table that make every value readable without hovering.
 */

/** Rounds up to 1, 2, 5 or 10 times a power of ten, so the top gridline is a clean number. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Which sample the pointer or the keyboard is on, or `null` when neither is.
 * `x0`, `step` and `width` are in the chart's own coordinates, so the index
 * follows the plot however wide it is drawn.
 */
export function useCursor({
  count,
  x0,
  step,
  width,
}: {
  count: number
  x0: number
  step: number
  width: number
}) {
  const [raw, setRaw] = useState<number | null>(null)
  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(count - 1, i)),
    [count]
  )
  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect()
      if (r.width === 0 || count === 0 || step === 0) return
      const x = ((e.clientX - r.left) / r.width) * width
      setRaw(clamp(Math.round((x - x0) / step)))
    },
    [clamp, count, step, width, x0]
  )
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        setRaw(null)
        return
      }
      const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (dir === 0) return
      e.preventDefault()
      setRaw((i) => clamp((i ?? count - 1) + dir))
    },
    [clamp, count]
  )
  return {
    index: raw === null || count === 0 ? null : clamp(raw),
    handlers: {
      onPointerMove,
      onPointerLeave: () => setRaw(null),
      onFocus: () => setRaw(count - 1),
      onBlur: () => setRaw(null),
      onKeyDown,
    },
  }
}

/**
 * Brings a new sample in: the line slides left by one step and the end dot
 * slides with it, then the dot gives one pulse. Does nothing on first render,
 * when the series is unchanged, or when the user asked for reduced motion.
 * `group` needs a `transition-transform` class and `dot` a `transition-[left]`
 * one; this only sets where they start from.
 */
export function useSlide(
  key: string,
  {
    group,
    dot,
    step,
    width,
    lastX,
  }: {
    group: RefObject<SVGGElement | null>
    dot: RefObject<HTMLElement | null>
    step: number
    width: number
    lastX: number
  }
): number {
  const first = useRef(true)
  const [pulse, setPulse] = useState(0)
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setPulse((p) => p + 1)
    if (prefersReducedMotion() || step === 0) return
    const g = group.current
    const d = dot.current
    if (!g || !d) return
    g.style.transition = 'none'
    g.style.transform = `translateX(${step}px)`
    d.style.transition = 'none'
    d.style.left = `${((lastX + step) / width) * 100}%`
    void g.getBoundingClientRect()
    g.style.transition = ''
    g.style.transform = ''
    d.style.transition = ''
    d.style.left = `${(lastX / width) * 100}%`
    // Only a changed series starts a slide; the rest is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return pulse
}

/** The value under the cursor, above the plot. `left` is a percentage of the plot's width. */
export function ChartTip({ left, text }: { left: number; text: string }) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] whitespace-nowrap text-popover-foreground tabular-nums shadow-md"
      style={{ left: `${Math.max(14, Math.min(86, left))}%` }}
    >
      {text}
    </div>
  )
}

/**
 * Every sample as text, newest first: the same data as the plot, for screen
 * readers. Visually hidden, so the chart carries no extra control.
 */
export function ChartTable({ rows }: { rows: Array<[string, string]> }) {
  return (
    <table className="sr-only">
      <tbody>
        {rows.map(([when, value], i) => (
          <tr key={i}>
            <td>{when}</td>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
