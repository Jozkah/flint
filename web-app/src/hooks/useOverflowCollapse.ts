import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Room to spare before collapsed content is brought back, so it cannot flicker. */
const HYSTERESIS_PX = 8

/**
 * Whether a row's content no longer fits and should move somewhere else.
 *
 * The row is watched as it is. When its content overflows even at its
 * narrowest, the width it needed is remembered and `collapsed` turns on; the
 * caller then renders less in the row. Once the row is wide enough for what it
 * needed, `collapsed` turns off again. Measured after every render as well as
 * on resize, so content that grows (a longer folder name, one more pill) is
 * caught too.
 */
export function useOverflowCollapse<T extends HTMLElement>(enabled = true) {
  const [collapsed, setCollapsed] = useState(false)
  const collapsedRef = useRef(false)
  const neededWidth = useRef(0)
  const [node, setNode] = useState<T | null>(null)

  const check = useCallback(() => {
    const el = node
    if (!el || !enabled) return
    const set = (next: boolean) => {
      if (collapsedRef.current === next) return
      collapsedRef.current = next
      setCollapsed(next)
    }
    if (!collapsedRef.current) {
      if (el.scrollWidth > el.clientWidth + 1) {
        neededWidth.current = el.scrollWidth
        set(true)
      }
    } else if (el.clientWidth >= neededWidth.current + HYSTERESIS_PX) {
      set(false)
    }
  }, [enabled, node])

  // After every render: content can change without the row resizing.
  useLayoutEffect(check)

  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, check])

  return { ref: setNode, collapsed: enabled && collapsed }
}
