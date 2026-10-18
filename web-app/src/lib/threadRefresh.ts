/**
 * Another tab or device may add to a thread this page shows: on a page served
 * by `flint serve`, a thread is read again when the page comes back into view
 * or regains focus, and the newer copy replaces this page's when it differs.
 */
import { useEffect, useRef } from 'react'

type Comparable = { id: string; content?: unknown }

/** Whether the server's copy of a thread differs from the one shown. */
export function threadChanged(
  shown: readonly Comparable[] | undefined,
  fetched: readonly Comparable[] | undefined
): boolean {
  const a = shown ?? []
  const b = fetched ?? []
  if (b.length === 0) return false
  if (a.length !== b.length) return true
  const byId = new Map(a.map((m) => [m.id, m]))
  return b.some((m) => {
    const mine = byId.get(m.id)
    return !mine || JSON.stringify(mine.content ?? null) !== JSON.stringify(m.content ?? null)
  })
}

/** Least time between two reads, so focus and visibility together read once. */
const MIN_GAP_MS = 1500

/**
 * Call `refresh` when the page becomes visible or the window gains focus,
 * while `enabled`. The latest `refresh` is used; at most one per `MIN_GAP_MS`.
 */
export function useRefreshWhenVisible(enabled: boolean, refresh: () => void): void {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    let last = 0
    const fire = () => {
      if (document.visibilityState === 'hidden') return
      const now = Date.now()
      if (now - last < MIN_GAP_MS) return
      last = now
      latest.current()
    }
    document.addEventListener('visibilitychange', fire)
    window.addEventListener('focus', fire)
    return () => {
      document.removeEventListener('visibilitychange', fire)
      window.removeEventListener('focus', fire)
    }
  }, [enabled])
}
