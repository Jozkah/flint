// The master notification switch: a list row whose knob carries a bell. Turning
// it on rings the bell; the line under the label crossfades between states.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { t } from '../i18n'
import { useReducedMotion } from './use-reduced-motion'

type BellSwitchProps = {
  label: ReactNode
  on: boolean
  /** Replaces the Off / On line while set (for example "Not set up on the computer"). */
  sub?: ReactNode
  onLabel?: string
  offLabel?: string
  /** Undefined disables the row, as the other switch rows do. */
  onClick?: () => void
  /** Shows the knob as working. */
  busy?: boolean
  testId?: string
}

const BELL = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 16.5V10a6 6 0 0 1 12 0v6.5l1.6 2.3H4.4L6 16.5z" />
    <path d="M10 21a2 2 0 0 0 4 0" />
  </svg>
)

export function BellSwitch({
  label,
  on,
  sub,
  onLabel = t('push.willNotify'),
  offLabel = t('common.off'),
  onClick,
  busy,
  testId,
}: BellSwitchProps) {
  const reduced = useReducedMotion()
  const [ring, setRing] = useState(0)
  const [armed, setArmed] = useState(false)
  const [prevOn, setPrevOn] = useState(on)
  // Ring when the user's own tap turned it on, not when saved state loads.
  if (prevOn !== on) {
    setPrevOn(on)
    if (on && armed && !reduced) setRing((r) => r + 1)
    setArmed(false)
  }
  return (
    <button
      type="button"
      className={`irow noic bs-row${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-busy={busy || undefined}
      data-testid={testId}
      data-on={on}
      data-busy={busy ? '' : undefined}
      data-reduced={reduced ? '' : undefined}
      onClick={
        onClick &&
        (() => {
          setArmed(!on)
          onClick()
        })
      }
    >
      <span className="lab">
        <span>{label}</span>
        {sub ? (
          <small>{sub}</small>
        ) : (
          <small className="bs-sub">
            <span className="off">{offLabel}</span>
            <span className="on" aria-hidden={!on}>
              {onLabel}
            </span>
          </small>
        )}
      </span>
      <span className="bs-sw" aria-hidden="true">
        <span className="bs-knob">
          <span
            key={ring}
            className="bs-glyph"
            data-ring={ring > 0 ? '' : undefined}
          >
            {BELL}
          </span>
          {ring > 0 && (
            <>
              <svg
                key={`l${ring}`}
                className="bs-wave l"
                viewBox="0 0 14 14"
                aria-hidden="true"
              >
                <path d="M14 8a6 6 0 0 0-6 6" />
                <path d="M14 4A10 10 0 0 0 4 14" />
              </svg>
              <svg
                key={`r${ring}`}
                className="bs-wave r"
                viewBox="0 0 14 14"
                aria-hidden="true"
              >
                <path d="M0 8a6 6 0 0 1 6 6" />
                <path d="M0 4a10 10 0 0 1 10 10" />
              </svg>
            </>
          )}
        </span>
      </span>
    </button>
  )
}
