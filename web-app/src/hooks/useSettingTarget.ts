import { useEffect, useRef } from 'react'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'

/** How long the arrival highlight stays up. Long enough to catch the eye on a
 * long page, short enough not to read as a permanent selection. */
const HIGHLIGHT_MS = 2000

/**
 * Reveal one setting when the search asks for it: scroll it into view, focus
 * it, and highlight it briefly.
 *
 * Returns the ref to attach to the group's own element. A hook rather than only
 * a wrapper component because `CardItem` styles its rows with parent-relative
 * selectors (`first:mt-0`, `last:border-none`): an extra wrapper element makes
 * every row both the first and the last child of its own wrapper, which strips
 * the dividers and spacing from every setting it is applied to.
 */
export function useSettingTarget(
  anchor: string
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const pendingTarget = useSettingsSearch((s) => s.pendingTarget)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (pendingTarget !== anchor) return
    if (!useSettingsSearch.getState().consumeTarget(anchor)) return
    const element = ref.current
    if (!element) return
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element.focus({ preventScroll: true })
    element.setAttribute('data-setting-highlight', 'true')
    // Held in a ref and NOT cleared by this effect's cleanup: `consumeTarget`
    // sets `pendingTarget` to null, which re-renders this subscriber and
    // changes this effect's own dependency — so a cleanup that cancelled the
    // timer would cancel it immediately, every time, and the highlight would
    // never fade. Only unmount clears it, below.
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      element.removeAttribute('data-setting-highlight')
      timer.current = null
    }, HIGHLIGHT_MS)
  }, [pendingTarget, anchor])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return ref
}

/** Classes that make a settings group focusable-on-arrival and highlightable.
 * Shared so the wrapper and `CardItem` present identically. */
export const settingTargetClasses =
  'scroll-mt-4 rounded-md outline-none transition-colors duration-500 ' +
  'data-[setting-highlight=true]:bg-accent/60 data-[setting-highlight=true]:ring-1 data-[setting-highlight=true]:ring-primary/40'

