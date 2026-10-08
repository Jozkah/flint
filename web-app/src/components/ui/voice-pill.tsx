import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChevronLeft, LoaderCircle, Mic } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import {
  CANCEL_DISTANCE,
  HOLD_AFTER_MS,
  SLIDE_MIN,
  displayLevel,
  formatClock,
  paintWave,
  pushWave,
  simulatedLevel,
  smoothLevel,
  type WaveState,
} from './voice-pill.helpers'

export type VoicePillEnd = 'tap' | 'release' | 'key' | 'cancel'

export interface VoicePillProps
  extends Omit<ComponentProps<'button'>, 'children'> {
  /** Recording is live: the pill is open. */
  listening: boolean
  /** Starting or stopping: presses are ignored and a spinner shows. */
  busy?: boolean
  /** Work is still pending while listening: the spinner replaces the stop square. */
  spinning?: boolean
  cancelLabel: string
  /** A press began from idle (tap, hold or key). */
  onBegin: () => void
  /** The recording should end; `cancel` means the user dragged it away. */
  onEnd: (reason: VoicePillEnd) => void
  /** Microphone level 0..1. Without it a speech-like simulation is drawn. */
  getLevel?: () => number
}

/**
 * A ghost icon button that opens to the left into a rounded pill while it
 * records: live waveform, m:ss timer and a stop square. Tap toggles; holding
 * past 300ms records only while held; dragging left past 64px cancels.
 */
export function VoicePill({
  listening,
  busy = false,
  spinning = false,
  cancelLabel,
  onBegin,
  onEnd,
  getLevel,
  className,
  ref,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
  onKeyUp,
  onClick,
  onContextMenu,
  ...rest
}: VoicePillProps) {
  const storeReduced = useInterfaceSettings((s) => s.reduceMotion)
  const osReduced = useReducedMotion()
  const reduced = storeReduced || !!osReduced

  const rootRef = useRef<HTMLButtonElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const timeRef = useRef<HTMLSpanElement | null>(null)
  const [pressed, setPressed] = useState(false)
  const [sliding, setSliding] = useState(false)

  const live = useRef({ listening, busy })
  const press = useRef({
    pointerId: null as number | null,
    downX: 0,
    downAt: 0,
    own: false,
    cancelled: false,
    releasedEarly: false,
    sliding: false,
    keyed: false,
  })

  useEffect(() => {
    live.current = { listening, busy }
    const p = press.current
    if (listening && p.releasedEarly) {
      p.releasedEarly = false
      onEnd('release')
    } else if (!listening && !busy) {
      p.releasedEarly = false
    }
  }, [listening, busy, onEnd])

  // Waveform and clock, only while the pill is open.
  useEffect(() => {
    if (!listening) return
    const canvas = waveRef.current
    const wave: WaveState = { hist: [], tick: 0, acc: 0 }
    let env = 0
    let startedAt = -1
    let last = 0
    let raf = 0
    if (timeRef.current) timeRef.current.textContent = formatClock(0)
    const color = canvas ? getComputedStyle(canvas).color : '#999'
    const frame = (now: number) => {
      if (startedAt < 0) {
        startedAt = now
        last = now
      }
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const target = getLevel
        ? displayLevel(getLevel())
        : Math.min(1, simulatedLevel((now - startedAt) / 1000))
      env = smoothLevel(env, target, dt)
      const text = formatClock(now - startedAt)
      if (timeRef.current && timeRef.current.textContent !== text) {
        timeRef.current.textContent = text
      }
      const scroll = pushWave(wave, env)
      const ctx = canvas?.getContext('2d') ?? null
      if (canvas && ctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const rect = canvas.getBoundingClientRect()
        const w = Math.max(1, Math.round(rect.width * dpr))
        const h = Math.max(1, Math.round(rect.height * dpr))
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        paintWave(ctx, w, h, dpr, wave.hist, scroll, color)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [listening, getLevel])

  const settleSlide = () => {
    press.current.sliding = false
    setSliding(false)
    rootRef.current?.style.setProperty('--vp-slide', '0px')
    rootRef.current?.style.setProperty('--vp-cancel', '0')
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(e)
    const p = press.current
    if (e.button !== 0 || !e.isPrimary || p.pointerId !== null) return
    if (live.current.busy || rest.disabled) return
    p.pointerId = e.pointerId
    p.downX = e.clientX
    p.downAt = performance.now()
    p.cancelled = false
    p.releasedEarly = false
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety */
    }
    setPressed(true)
    p.own = !live.current.listening
    if (p.own) onBegin()
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerMove?.(e)
    const p = press.current
    if (p.pointerId !== e.pointerId || !live.current.listening || !p.own) return
    const dx = e.clientX - p.downX
    if (!p.sliding && dx > -SLIDE_MIN) return
    if (!p.sliding) {
      p.sliding = true
      setSliding(true)
    }
    const pull = Math.min(CANCEL_DISTANCE + 24, Math.max(0, -dx))
    const progress = Math.min(1, pull / CANCEL_DISTANCE)
    rootRef.current?.style.setProperty('--vp-slide', `${-pull}px`)
    rootRef.current?.style.setProperty('--vp-cancel', progress.toFixed(3))
    if (progress >= 1) {
      p.cancelled = true
      settleSlide()
      onEnd('cancel')
    }
  }

  const finishPointer = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current
    if (e.pointerId !== p.pointerId) return
    p.pointerId = null
    setPressed(false)
    if (p.sliding) settleSlide()
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* already released */
    }
    if (p.cancelled) return
    const isHold = performance.now() - p.downAt >= HOLD_AFTER_MS
    if (p.own) {
      if (!isHold) return
      if (live.current.listening) onEnd('release')
      else if (live.current.busy) p.releasedEarly = true
    } else if (live.current.listening) {
      onEnd(isHold ? 'release' : 'tap')
    }
  }

  const showSpinner = busy || (listening && spinning)

  return (
    <button
      {...rest}
      ref={(node) => {
        rootRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      type="button"
      aria-disabled={busy || undefined}
      className={cn('vp-root', className)}
      data-state={listening ? 'listening' : 'idle'}
      data-pressed={pressed ? '' : undefined}
      data-sliding={sliding ? '' : undefined}
      data-busy={showSpinner ? '' : undefined}
      data-reduced={reduced ? '' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => {
        onPointerUp?.(e)
        finishPointer(e)
      }}
      onPointerCancel={(e) => {
        onPointerCancel?.(e)
        finishPointer(e)
      }}
      onLostPointerCapture={(e) => {
        onLostPointerCapture?.(e)
        finishPointer(e)
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return
        e.preventDefault()
        if (live.current.busy || rest.disabled) return
        press.current.keyed = true
        if (live.current.listening) onEnd('key')
        else onBegin()
      }}
      onKeyUp={(e) => {
        onKeyUp?.(e)
        if (e.key === ' ') e.preventDefault()
        setTimeout(() => {
          press.current.keyed = false
        }, 0)
      }}
      // Assistive tech activates with a click that carries no pointer.
      onClick={(e) => {
        onClick?.(e)
        if (e.detail !== 0 || press.current.keyed) return
        if (live.current.busy || rest.disabled) return
        if (live.current.listening) onEnd('tap')
        else onBegin()
      }}
      onContextMenu={(e) => {
        onContextMenu?.(e)
        e.preventDefault()
      }}
    >
      <span className="vp-bg" aria-hidden="true" />
      <canvas ref={waveRef} className="vp-wave" aria-hidden="true" />
      <span className="vp-cancel" aria-hidden="true">
        <ChevronLeft className="size-3" strokeWidth={2.2} />
        <span>{cancelLabel}</span>
      </span>
      <span ref={timeRef} className="vp-time" aria-hidden="true">
        0:00
      </span>
      <span className="vp-ico">
        <span className="vp-mic">
          <Mic />
        </span>
        <span className="vp-stopsq" aria-hidden="true" />
        <span className="vp-spin" aria-hidden="true">
          <LoaderCircle className="size-4 motion-safe:animate-spin" />
        </span>
      </span>
    </button>
  )
}
