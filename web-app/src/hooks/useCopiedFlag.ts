import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A "copied" flag that turns itself off after `ms`. One timer at a time, and
 * cleared on unmount, so a fast second copy or leaving the view does not set
 * state on a stale timer (F8x2-008).
 */
export function useCopiedFlag(ms = 1500): [boolean, (on: boolean) => void] {
  const [copied, setCopiedState] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const setCopied = useCallback(
    (on: boolean) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setCopiedState(on)
      if (on) {
        timer.current = setTimeout(() => {
          timer.current = null
          setCopiedState(false)
        }, ms)
      }
    },
    [ms]
  )
  return [copied, setCopied]
}
