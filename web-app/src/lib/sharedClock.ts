import { useSyncExternalStore } from 'react'

/**
 * A clock shared by every subscriber: one timer per period instead of one per
 * component. It does not tick while the window is hidden and catches up (one
 * tick) when it is shown again.
 */
export type SharedClock = {
  subscribe: (listener: () => void) => () => void
  now: () => number
  /** For tests: live subscribers and whether a timer is armed. */
  state: () => { listeners: number; armed: boolean }
}

export function createSharedClock(periodMs: number): SharedClock {
  const listeners = new Set<() => void>()
  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null

  const hidden = () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden'

  const tick = () => {
    now = Date.now()
    listeners.forEach((l) => l())
  }
  const start = () => {
    if (timer || hidden()) return
    timer = setInterval(tick, periodMs)
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const onVisibility = () => {
    if (hidden()) stop()
    else {
      tick()
      start()
    }
  }

  return {
    subscribe(listener) {
      if (listeners.size === 0) {
        now = Date.now()
        start()
        if (typeof document !== 'undefined')
          document.addEventListener('visibilitychange', onVisibility)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stop()
          if (typeof document !== 'undefined')
            document.removeEventListener('visibilitychange', onVisibility)
        }
      }
    },
    now: () => {
      // Without subscribers nothing advances it; refresh at most once a
      // period so repeated reads in one render agree.
      if (!listeners.size && Date.now() - now >= periodMs) now = Date.now()
      return now
    },
    state: () => ({ listeners: listeners.size, armed: timer !== null }),
  }
}

/** The one-second clock behind every elapsed-time counter. */
export const secondClock = createSharedClock(1000)

const noopSubscribe = () => () => {}

/**
 * The current time, re-rendering once a second while `enabled`, from the
 * shared second clock (no timer of its own; paused while the window is
 * hidden). When disabled it returns the time of the last render and never
 * re-renders on its own.
 */
export function useSecondClock(enabled = true): number {
  return useSyncExternalStore(
    enabled ? secondClock.subscribe : noopSubscribe,
    secondClock.now
  )
}
