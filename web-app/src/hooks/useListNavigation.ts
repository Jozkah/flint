import { useCallback, useEffect, useState } from 'react'

type Options = {
  /** How many rows the list has. */
  count: number
  /** Past the last row comes the first (and back), instead of stopping. */
  wrap?: boolean
  /**
   * Home/End jump to the first/last row. Off by default: every current list
   * is driven from a text field, where Home/End move the caret.
   */
  homeEnd?: boolean
  /** The highlight goes back to the first row whenever this changes. */
  resetKey?: unknown
  /** Bring a row into view after the highlight moves to it. */
  scrollTo?: (index: number) => void
}

/**
 * The highlighted row of a keyboard-driven result list (search dialog,
 * command palette, settings search): arrow keys move it, it resets when the
 * results change, and the row it lands on is scrolled into view. Enter stays
 * with the caller, which knows what a row does.
 */
export function useListNavigation({
  count,
  wrap = false,
  homeEnd = false,
  resetKey,
  scrollTo,
}: Options) {
  const [active, setActive] = useState(0)

  useEffect(() => {
    setActive(0)
  }, [resetKey])

  useEffect(() => {
    scrollTo?.(active)
  }, [active, scrollTo])

  /** Handle a navigation key; true when it was one (and was consumed). */
  const onNavKey = useCallback(
    (e: Pick<React.KeyboardEvent, 'key' | 'preventDefault'>): boolean => {
      const last = Math.max(count - 1, 0)
      let next: ((i: number) => number) | null = null
      if (e.key === 'ArrowDown') {
        next = wrap ? (i) => (count ? (i + 1) % count : 0) : (i) => Math.min(i + 1, last)
      } else if (e.key === 'ArrowUp') {
        next = wrap ? (i) => (count ? (i - 1 + count) % count : 0) : (i) => Math.max(i - 1, 0)
      } else if (homeEnd && e.key === 'Home') {
        next = () => 0
      } else if (homeEnd && e.key === 'End') {
        next = () => last
      }
      if (!next) return false
      e.preventDefault()
      setActive(next)
      return true
    },
    [count, wrap, homeEnd]
  )

  return { active, setActive, onNavKey }
}
