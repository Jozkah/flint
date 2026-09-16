import { useCallback, useEffect, useRef, useState } from 'react'
import {
  consolidateMemory,
  type ConsolidationOutcome,
} from '@/lib/agentWorkspace'

/**
 * Schedules idle-time memory consolidation ("autoDream").
 *
 * The hook is only a scheduler: it resets an idle clock on pointer/keyboard
 * activity, polls on an interval, and once the machine has been idle past
 * `idleSecs` it calls `consolidateMemory(idleSecs, false)`. The *backend* is the
 * real gate — it stays disabled unless the store's config enabled it, and it
 * enforces the cross-process lock, path safety and atomic write regardless of
 * what the hook does — so a spurious call is a cheap no-op ("disabled" /
 * "nothing new" / "busy"), never a forced run.
 *
 * `runNow` triggers a manual consolidation (`manual = true`), which bypasses the
 * enabled/idle gates but nothing else.
 */
export interface UseMemoryConsolidationOptions {
  /** Seconds of inactivity before the auto path fires. Default 300 (5 min). */
  idleSecs?: number
  /** How often to check the idle clock, in ms. Default 30_000. */
  pollMs?: number
  /** Turn the auto poller on. `false` leaves only `runNow` live. Default true. */
  enabled?: boolean
}

export interface MemoryConsolidationState {
  /** A consolidation call is in flight. */
  running: boolean
  /** The most recent outcome, or null before the first completed call. */
  last: ConsolidationOutcome | null
  /** The most recent error message, or null. */
  error: string | null
  /** Epoch ms of the last completed call (ran or skipped), or null. */
  lastRunAt: number | null
  /** Trigger a manual consolidation now (bypasses the idle gate). */
  runNow: () => Promise<ConsolidationOutcome | null>
}

const DEFAULT_IDLE_SECS = 300
const DEFAULT_POLL_MS = 30_000

export function useMemoryConsolidation(
  options: UseMemoryConsolidationOptions = {}
): MemoryConsolidationState {
  const {
    idleSecs = DEFAULT_IDLE_SECS,
    pollMs = DEFAULT_POLL_MS,
    enabled = true,
  } = options

  const [running, setRunning] = useState(false)
  const [last, setLast] = useState<ConsolidationOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastRunAt, setLastRunAt] = useState<number | null>(null)

  // The last moment the user was seen active. A ref, not state: it changes on
  // every pointer move and must not re-render.
  const lastActivityRef = useRef<number>(Date.now())
  // Guards against overlapping calls without forcing a re-render mid-flight.
  const inFlightRef = useRef<boolean>(false)

  const run = useCallback(
    async (manual: boolean): Promise<ConsolidationOutcome | null> => {
      if (inFlightRef.current) return null
      inFlightRef.current = true
      setRunning(true)
      setError(null)
      try {
        const outcome = await consolidateMemory(idleSecs, manual)
        setLast(outcome)
        setLastRunAt(Date.now())
        return outcome
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setLastRunAt(Date.now())
        return null
      } finally {
        inFlightRef.current = false
        setRunning(false)
      }
    },
    [idleSecs]
  )

  const runNow = useCallback(() => {
    // A manual run counts as activity: it resets the idle clock so the auto
    // path does not immediately fire again on top of it.
    lastActivityRef.current = Date.now()
    return run(true)
  }, [run])

  // Reset the idle clock on any user activity.
  useEffect(() => {
    if (!enabled) return
    const bump = () => {
      lastActivityRef.current = Date.now()
    }
    const events: Array<keyof WindowEventMap> = [
      'pointermove',
      'pointerdown',
      'keydown',
      'wheel',
      'touchstart',
    ]
    events.forEach((ev) => window.addEventListener(ev, bump, { passive: true }))
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, bump))
    }
  }, [enabled])

  // Poll: once idle past the threshold, fire the auto path.
  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      const idleForMs = Date.now() - lastActivityRef.current
      if (idleForMs >= idleSecs * 1000 && !inFlightRef.current) {
        void run(false)
      }
    }
    const id = window.setInterval(tick, pollMs)
    return () => window.clearInterval(id)
  }, [enabled, idleSecs, pollMs, run])

  return { running, last, error, lastRunAt, runNow }
}
