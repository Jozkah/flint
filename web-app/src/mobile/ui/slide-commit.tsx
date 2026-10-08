// A slide-to-confirm control: drag the handle across the track to commit. An
// early release springs back; the call's pending, done and failed states show
// on the handle. It is also a slider for keyboards and assistive tech.
import { useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { t } from '../i18n'
import { useReducedMotion } from './use-reduced-motion'

const HEIGHT = 44
const PAD = 4
const GRIP = HEIGHT - PAD * 2
const THRESHOLD = 0.9
const MIN_PENDING_MS = 300
const ERROR_HOLD_MS = 1600
const STEP = 0.25

type Phase = 'idle' | 'pending' | 'done' | 'error'

export type SlideCommitProps = {
  label: string
  errorLabel?: string
  doneLabel?: string
  /** Resolve false (or reject) when the action failed. */
  onCommit: () => Promise<unknown>
  disabled?: boolean
  testId?: string
}

export function SlideCommit({
  label,
  errorLabel = t('common.didNotWorkRetry'),
  doneLabel = t('common.allowed'),
  onCommit,
  disabled,
  testId,
}: SlideCommitProps) {
  const reduced = useReducedMotion()
  const trackRef = useRef<HTMLDivElement>(null)
  const travelRef = useRef(1)
  const drag = useRef<{ id: number; x0: number; from: number } | null>(null)
  const alive = useRef(true)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const [progress, setProgress] = useState(0)
  const [held, setHeld] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')

  useEffect(() => {
    alive.current = true
    const list = timers.current
    return () => {
      alive.current = false
      list.forEach(clearTimeout)
    }
  }, [])

  const measure = () => {
    const w = trackRef.current?.offsetWidth || 220
    travelRef.current = Math.max(1, w - PAD * 2 - GRIP)
  }

  const run = () => {
    if (phase !== 'idle' || disabled) return
    setProgress(1)
    setPhase('pending')
    const started = Date.now()
    const finish = (ok: boolean) => {
      const wait = Math.max(0, MIN_PENDING_MS - (Date.now() - started))
      timers.current.push(
        setTimeout(() => {
          if (!alive.current) return
          if (ok) {
            setPhase('done')
            return
          }
          setPhase('error')
          timers.current.push(
            setTimeout(() => {
              if (!alive.current) return
              setPhase('idle')
              setProgress(0)
            }, ERROR_HOLD_MS)
          )
        }, wait)
      )
    }
    let call: Promise<unknown>
    try {
      call = Promise.resolve(onCommit())
    } catch {
      call = Promise.reject(new Error('failed'))
    }
    call.then(
      (r) => finish(r !== false),
      () => finish(false)
    )
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (
      phase !== 'idle' ||
      disabled ||
      drag.current ||
      (e.button !== undefined && e.button !== 0)
    )
      return
    measure()
    drag.current = { id: e.pointerId, x0: e.clientX, from: progress }
    setHeld(true)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      /* pointer already gone */
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    setProgress(
      Math.min(1, Math.max(0, d.from + (e.clientX - d.x0) / travelRef.current))
    )
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    setHeld(false)
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      /* not captured */
    }
    if (e.type !== 'pointercancel' && progress >= THRESHOLD) run()
    else setProgress(0)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (phase !== 'idle' || disabled) return
    if (e.key === 'End') {
      e.preventDefault()
      run()
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(1, progress + STEP)
      setProgress(next)
      if (next >= 1) run()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      setProgress(Math.max(0, progress - STEP))
    } else if (e.key === 'Home' || e.key === 'Escape') {
      e.preventDefault()
      setProgress(0)
    }
  }

  return (
    <div
      className="sc-root"
      data-phase={phase}
      data-held={held ? '' : undefined}
      data-reduced={reduced ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
    >
      <div
        ref={trackRef}
        className="sc-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div
          className="sc-say"
          aria-hidden="true"
          style={{
            opacity:
              phase === 'idle' ? Math.max(0, 1 - progress * 1.6) : undefined,
          }}
        >
          <span>{label}</span>
          <span>{errorLabel}</span>
        </div>
        <div
          className="sc-cap"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={
            phase === 'pending'
              ? t('common.working')
              : phase === 'done'
                ? doneLabel
                : phase === 'error'
                  ? errorLabel
                  : undefined
          }
          aria-busy={phase === 'pending' || undefined}
          aria-disabled={disabled || undefined}
          data-testid={testId}
          style={{
            left: `calc(${PAD}px + ${progress} * (100% - ${PAD * 2 + GRIP}px))`,
          }}
          onKeyDown={onKeyDown}
        >
          <span className="sc-ic arrow" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          <span className="sc-ic spin" aria-hidden="true">
            <svg
              className="sc-spinner"
              width="18"
              height="18"
              viewBox="0 0 24 24"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeOpacity=".25"
              />
              <path
                d="M12 3a9 9 0 0 1 9 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="sc-ic ok" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12.5 10 17.5 19 7" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  )
}
