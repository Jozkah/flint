import { useLayoutEffect, useRef, useState } from 'react'

/**
 * How long answer buttons stay disabled after the request under them changes.
 * Long enough to swallow the second click of a double-click or a repeated
 * key press, short enough not to be noticed when reading a new prompt.
 */
export const REARM_MS = 600

/**
 * False for a moment after `key` changes from one request to another.
 *
 * When one approval is answered, the next is shown in the same place -- the
 * same buttons, under the same pointer and focus. Without a pause, the second
 * click of a double-click, or a second Enter, answers a request whose diff was
 * never on screen. The first request shown is armed at once: nothing was
 * clicked before it.
 */
export function useArmedAfterChange(
  key: string | undefined,
  ms: number = REARM_MS
): boolean {
  const [armed, setArmed] = useState(true)
  const previous = useRef(key)
  // Layout, not passive: the buttons are disabled before the browser can
  // deliver another event to them.
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = key
    if (before === key || before === undefined || key === undefined) return
    setArmed(false)
    const timer = window.setTimeout(() => setArmed(true), ms)
    return () => window.clearTimeout(timer)
  }, [key, ms])
  return armed
}
