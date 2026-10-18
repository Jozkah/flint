import { useSecondClock } from '@/lib/sharedClock'

/**
 * Whole seconds elapsed since `startTime` (plus `baseMs` already accumulated),
 * re-rendering once a second while `startTime` is set. Returns undefined when
 * not running, so callers only show a live counter during streaming.
 */
export function useElapsedSeconds(
  startTime: number | null,
  baseMs = 0
): number | undefined {
  // The shared one-second clock (paused while the window is hidden).
  const now = useSecondClock(startTime !== null)
  if (startTime === null) return undefined
  return Math.max(0, Math.floor((baseMs + now - startTime) / 1000))
}
