import { useEffect, useState } from 'react'

/**
 * Whole seconds elapsed since `startTime` (plus `baseMs` already accumulated),
 * re-rendering once a second while `startTime` is set. Returns undefined when
 * not running, so callers only show a live counter during streaming.
 */
export function useElapsedSeconds(
  startTime: number | null,
  baseMs = 0
): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startTime === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startTime])
  if (startTime === null) return undefined
  return Math.max(0, Math.floor((baseMs + now - startTime) / 1000))
}
