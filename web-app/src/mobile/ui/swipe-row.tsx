// A row that swipes left to reveal two actions. Past the actions the drag
// resists like a rubber band; a long swipe commits the primary action, which
// expands to fill the row before the row slides out and collapses.
import { useEffect, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import { useReducedMotion } from './use-reduced-motion'

const ACTION_W = 76
const D = ACTION_W * 2
const HYSTERESIS = 10
const FLICK = 110
const DECEL = 0.998
const RESIST = 0.55
const COMMIT_AT = 0.6
const SLIDE_MS = 220
const COLLAPSE_MS = 200

export type SwipeAction = { label: string; icon: ReactNode }

export type SwipeRowProps = {
  children: ReactNode
  /** Neutral action revealed first (Restore). */
  secondary: SwipeAction & { onSelect: () => void }
  /** Destructive action; a long swipe commits it (Delete). */
  primary: SwipeAction & {
    /** Return false to cancel before the row leaves (a confirmation). */
    confirm?: () => boolean
    /** Fires after the row has slid out and collapsed. Resolve false to bring the row back. */
    onCommit: () => unknown
  }
  /** Names the visually hidden button that toggles the actions. */
  toggleLabel: string
  testId?: string
}

type Phase = 'idle' | 'committing' | 'collapsing'

const rubber = (o: number, dim: number, c: number) =>
  (o * dim * c) / (dim + c * Math.abs(o))

function commitPoint(width: number) {
  return Math.max(COMMIT_AT * width, D + ACTION_W / 2)
}

/** Maps the raw finger travel to how far the row is pulled open. */
function mapExposure(raw: number, width: number) {
  if (raw < 0) return rubber(raw, width, RESIST)
  if (raw <= D) return raw
  const C = commitPoint(width)
  const knee = D + (C - D) / RESIST
  return raw <= knee
    ? D + RESIST * (raw - D)
    : C + rubber(raw - knee, width, RESIST)
}

type Grip = {
  id: number
  x0: number
  y0: number
  start: number
  grabbed: boolean
  hist: Array<[number, number]>
}

export function SwipeRow({
  children,
  secondary,
  primary,
  toggleLabel,
  testId,
}: SwipeRowProps) {
  const reduced = useReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(320)
  const grip = useRef<Grip | null>(null)
  const moved = useRef(false)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const exRef = useRef(0)
  const [ex, setEx] = useState(0)
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [collapsed, setCollapsed] = useState(false)

  const setExposure = (v: number) => {
    exRef.current = v
    setEx(v)
  }
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms))
  }
  useEffect(() => {
    const list = timers.current
    return () => list.forEach(clearTimeout)
  }, [])

  const settle = (target: number) => {
    setOpen(target === D)
    setExposure(target)
  }

  const commit = () => {
    if (phase !== 'idle') return
    if (primary.confirm && !primary.confirm()) {
      settle(0)
      return
    }
    setPhase('committing')
    setExposure(widthRef.current)
    later(
      () => {
        const el = wrapRef.current
        if (el) {
          el.style.height = `${el.offsetHeight}px`
          void el.offsetHeight
          el.style.height = '0px'
        }
        setPhase('collapsing')
        later(
          () => {
            setCollapsed(true)
            void Promise.resolve(primary.onCommit()).then((r) => {
              if (r !== false) return
              // Refused: bring the row back.
              setCollapsed(false)
              setPhase('idle')
              if (wrapRef.current) wrapRef.current.style.height = ''
              settle(0)
            })
          },
          reduced ? 0 : COLLAPSE_MS
        )
      },
      reduced ? 0 : SLIDE_MS
    )
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (
      phase !== 'idle' ||
      grip.current ||
      (e.button !== undefined && e.button !== 0)
    )
      return
    widthRef.current = wrapRef.current?.offsetWidth || widthRef.current
    moved.current = false
    grip.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      start: exRef.current,
      grabbed: false,
      hist: [],
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grip.current
    if (!g || g.id !== e.pointerId) return
    const dx = e.clientX - g.x0
    if (!g.grabbed) {
      // Mostly-vertical drags belong to the scroller.
      if (
        Math.abs(dx) < HYSTERESIS ||
        Math.abs(dx) < Math.abs(e.clientY - g.y0)
      )
        return
      g.grabbed = true
      moved.current = true
      setDragging(true)
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      } catch {
        /* pointer already gone */
      }
    }
    const travelled = dx - Math.sign(dx) * HYSTERESIS
    const next = mapExposure(g.start - travelled, widthRef.current)
    g.hist.push([e.timeStamp, next])
    if (g.hist.length > 4) g.hist.shift()
    setExposure(next)
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grip.current
    if (!g || g.id !== e.pointerId) return
    grip.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      /* not captured */
    }
    if (!g.grabbed) return
    const cur = exRef.current
    if (cur >= commitPoint(widthRef.current)) {
      commit()
      return
    }
    let v = 0
    if (g.hist.length >= 2) {
      const a = g.hist[0]
      const b = g.hist[g.hist.length - 1]
      v = ((b[1] - a[1]) / Math.max(1, b[0] - a[0])) * 1000
    }
    const proj = cur + ((v / 1000) * DECEL) / (1 - DECEL)
    const target = Math.abs(v) >= FLICK ? (v > 0 ? D : 0) : proj > D / 2 ? D : 0
    settle(target)
  }

  // A tap on an open row closes it; the click that ends a drag is not a tap.
  const onClickCapture = (e: ReactMouseEvent) => {
    if (moved.current) {
      moved.current = false
      e.preventDefault()
      e.stopPropagation()
    } else if (open) {
      e.preventDefault()
      e.stopPropagation()
      settle(0)
    }
  }

  const spread = phase === 'committing' || ex >= commitPoint(widthRef.current)
  return (
    <div
      ref={wrapRef}
      className="sr-wrap"
      data-testid={testId}
      data-phase={phase}
      data-open={open ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-collapsed={collapsed ? '' : undefined}
      data-reduced={reduced ? '' : undefined}
    >
      <div className="sr-clip">
        <div className="sr-rail" aria-hidden={!open}>
          <button
            type="button"
            className="sr-act sr-sec"
            tabIndex={open ? 0 : -1}
            onClick={() => {
              settle(0)
              secondary.onSelect()
            }}
          >
            <span>
              {secondary.icon}
              <span>{secondary.label}</span>
            </span>
          </button>
          <div
            className="sr-prim"
            style={
              spread ? { width: `${Math.max(ex, ACTION_W)}px` } : undefined
            }
            data-spread={spread ? '' : undefined}
          >
            <button
              type="button"
              className="sr-act"
              tabIndex={open ? 0 : -1}
              onClick={commit}
            >
              <span>
                {primary.icon}
                <span>{primary.label}</span>
              </span>
            </button>
          </div>
        </div>
        <div
          className="sr-surf"
          style={{ transform: `translateX(${-ex}px)` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClickCapture={onClickCapture}
        >
          {children}
        </div>
      </div>
      <button
        type="button"
        className="sr-sr"
        aria-expanded={open}
        aria-label={toggleLabel}
        onClick={() => settle(open ? 0 : D)}
      />
    </div>
  )
}
