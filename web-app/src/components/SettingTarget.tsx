import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'

/** How long the arrival highlight stays up. Long enough to catch the eye on a
 * long page, short enough not to read as a permanent selection. */
const HIGHLIGHT_MS = 2000

/**
 * Marks one setting as a navigable search target.
 *
 * Every settings page wraps its controls in this rather than growing its own
 * scroll/focus logic, so "open this setting" behaves identically everywhere.
 * The `anchor` is the registry's stable id (`settings-appearance-theme`),
 * never a translated string: a label that changes with the language would
 * break every link into it.
 *
 * On arrival the group is scrolled into view, focused (programmatically
 * focusable, but not a tab stop, so keyboard order is unchanged) and briefly
 * highlighted. The pending id is claimed once, so a later visit is quiet.
 */
export function SettingTarget({
  anchor,
  children,
  className,
}: {
  anchor: string
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const pendingTarget = useSettingsSearch((s) => s.pendingTarget)

  useEffect(() => {
    if (pendingTarget !== anchor) return
    if (!useSettingsSearch.getState().consumeTarget(anchor)) return
    const element = ref.current
    if (!element) return
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element.focus({ preventScroll: true })
    element.setAttribute('data-setting-highlight', 'true')
    const timer = setTimeout(
      () => element.removeAttribute('data-setting-highlight'),
      HIGHLIGHT_MS
    )
    return () => clearTimeout(timer)
  }, [pendingTarget, anchor])

  return (
    <div
      ref={ref}
      id={anchor}
      data-setting-anchor={anchor}
      // -1: reachable when we focus it on arrival, but never inserted into the
      // page's own tab order.
      tabIndex={-1}
      className={cn(
        'scroll-mt-4 rounded-md outline-none transition-colors duration-500',
        'data-[setting-highlight=true]:bg-accent/60 data-[setting-highlight=true]:ring-1 data-[setting-highlight=true]:ring-primary/40',
        className
      )}
    >
      {children}
    </div>
  )
}
