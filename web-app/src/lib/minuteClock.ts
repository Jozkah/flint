import { useSyncExternalStore } from 'react'

/**
 * One shared clock that ticks once a minute for every subscriber, instead of
 * a timer per component (the sidebar mounted one per chat row: 2,000 chats
 * meant 2,000 intervals, each re-rendering its row every minute). It does
 * not tick while the window is hidden and catches up on the next show.
 */
const TICK_MS = 60_000

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function tick() {
  now = Date.now()
  listeners.forEach((l) => l())
}

function onVisibility() {
  if (hidden()) stop()
  else {
    tick()
    start()
  }
}

function start() {
  if (timer || hidden()) return
  timer = setInterval(tick, TICK_MS)
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

export function subscribeMinute(listener: () => void): () => void {
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
}

export function minuteNow(): number {
  return listeners.size ? now : Date.now()
}

/**
 * `select(now)` re-evaluated on every shared tick; the component re-renders
 * only when the selected value changes, so a row whose "recent" state does
 * not flip stays untouched.
 */
export function useMinuteClock<T extends string | number | boolean>(
  select: (now: number) => T
): T {
  return useSyncExternalStore(subscribeMinute, () => select(minuteNow()))
}

/** For tests: number of live subscribers and whether a timer is armed. */
export function minuteClockState() {
  return { listeners: listeners.size, armed: timer !== null }
}
