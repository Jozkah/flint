// A number field you can also scrub: drag across it to change the value
// (2px per step), with a delta bubble, a fill bar for the position between min
// and max, and rubber-band resistance at the limits. A tap still focuses the
// input so the number can be typed.
import { useId, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useReducedMotion } from './use-reduced-motion'

const PX_PER_STEP = 2
const ARM_PX = 6
const RESIST = 0.35
const MAX_OVER = 28

export type ScrubFieldProps = {
  label: ReactNode
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  /** Called with the finished number: after typing (on blur) and after a scrub. */
  onCommit: (value: number) => void
}

type Scrub = { id: number; x0: number; start: number; armed: boolean }

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

export function ScrubField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onCommit,
}: ScrubFieldProps) {
  const reduced = useReducedMotion()
  const id = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrub = useRef<Scrub | null>(null)
  const scrubbed = useRef(false)
  const [draft, setDraft] = useState(String(value))
  const [prevValue, setPrevValue] = useState(value)
  const [dragging, setDragging] = useState(false)
  const [delta, setDelta] = useState(0)
  const [over, setOver] = useState(0)
  const [bubbleX, setBubbleX] = useState(0)
  if (prevValue !== value) {
    setPrevValue(value)
    setDraft(String(value))
  }

  const lo = min ?? -Infinity
  const hi = max ?? Infinity
  const bounded = min !== undefined && max !== undefined && max > min
  const shown = Number(draft)
  const fill =
    bounded && Number.isFinite(shown)
      ? clamp((shown - lo) / (hi - lo), 0, 1)
      : 0

  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || scrub.current || (e.button !== undefined && e.button !== 0))
      return
    const base = Number(draft)
    scrub.current = {
      id: e.pointerId,
      x0: e.clientX,
      start: Number.isFinite(base) ? base : value,
      armed: false,
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const s = scrub.current
    if (!s || s.id !== e.pointerId) return
    const dx = e.clientX - s.x0
    if (!s.armed) {
      if (Math.abs(dx) < ARM_PX) return
      s.armed = true
      setDragging(true)
      // Blurring here must not commit the half-scrubbed number.
      scrubbed.current = true
      inputRef.current?.blur()
      scrubbed.current = false
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      } catch {
        /* pointer already gone */
      }
    }
    const steps = Math.trunc(dx / PX_PER_STEP)
    const raw = s.start + steps * step
    const next = clamp(raw, lo, hi)
    // Past a limit the field keeps following the finger, but only a little.
    const excess = ((raw - next) / step) * PX_PER_STEP
    setOver(
      reduced
        ? 0
        : Math.sign(excess) * Math.min(MAX_OVER, Math.abs(excess) * RESIST)
    )
    setDraft(String(Number(next.toFixed(6))))
    setDelta(next - s.start)
    const w = rootRef.current?.offsetWidth ?? 0
    setBubbleX(
      w
        ? clamp(
            e.clientX - (rootRef.current?.getBoundingClientRect().left ?? 0),
            14,
            Math.max(14, w - 14)
          )
        : 14
    )
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const s = scrub.current
    if (!s || s.id !== e.pointerId) return
    scrub.current = null
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      /* not captured */
    }
    if (!s.armed) return
    setDragging(false)
    setOver(0)
    const final = Number(draft)
    if (e.type === 'pointercancel') {
      setDraft(String(s.start))
      return
    }
    if (Number.isFinite(final) && final !== s.start) onCommit(final)
  }

  return (
    <div className="field sf-field">
      <label htmlFor={id}>{label}</label>
      <span
        ref={rootRef}
        className="sf-root"
        data-dragging={dragging}
        data-over={over !== 0}
        data-disabled={disabled ? '' : undefined}
        data-reduced={reduced ? '' : undefined}
        style={over ? { transform: `translateX(${over}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {bounded && (
          <span className="sf-fillw" aria-hidden="true">
            <span
              className="sf-fill"
              style={{ transform: `scaleX(${fill})` }}
            />
          </span>
        )}
        <input
          ref={inputRef}
          id={id}
          className="sf-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => {
            if (scrubbed.current) {
              scrubbed.current = false
              return
            }
            const n = Number(e.currentTarget.value)
            if (e.currentTarget.value.trim() !== '' && Number.isFinite(n))
              onCommit(n)
          }}
        />
        <span
          className="sf-ghost"
          aria-hidden="true"
          data-testid="scrub-delta"
          style={{ left: `${bubbleX}px`, translate: '-50% -100%' }}
        >
          {delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : '0'}
        </span>
      </span>
    </div>
  )
}
