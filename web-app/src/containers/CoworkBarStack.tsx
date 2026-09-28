import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The bars over the Cowork composer -- review ready, the session's branch,
 * its pull request, notices -- as a stack: the first `max` that have anything
 * to show, and a "Show N more" chip for the rest.
 *
 * Each bar decides for itself whether it renders (a PR bar with no PR renders
 * nothing), so the stack counts the slots that are filled on screen rather
 * than the children it was given.
 */
export function CoworkBarStack({
  children,
  max = 2,
}: {
  children: ReactNode
  max?: number
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [filled, setFilled] = useState<boolean[]>([])
  const [expanded, setExpanded] = useState(false)
  const slots = Children.toArray(children)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const next = [...el.querySelectorAll<HTMLElement>(':scope > [data-bar-slot]')].map(
        (slot) => slot.childElementCount > 0
      )
      setFilled((prev) =>
        prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next
      )
    }
    measure()
    if (typeof MutationObserver === 'undefined') return
    // Only whether a slot has content: attribute changes (including the
    // `hidden` set below) are not watched, so this cannot feed itself.
    const observer = new MutationObserver(measure)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [slots.length])

  let seen = 0
  const hiddenAt = filled.map((isFilled) => {
    if (!isFilled) return false
    seen += 1
    return !expanded && seen > max
  })
  const extra = Math.max(0, seen - max)

  return (
    <div ref={ref} data-testid="cowork-bar-stack">
      {slots.map((child, i) => (
        // Keyed by the child's own position in the JSX, so a bar appearing or
        // going away does not remount the bars after it.
        <div
          key={isValidElement(child) && child.key != null ? child.key : i}
          data-bar-slot=""
          hidden={hiddenAt[i] || undefined}
        >
          {child}
        </div>
      ))}
      {extra > 0 && (
        <button
          type="button"
          data-testid="cowork-bar-stack-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mb-2 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-hover-row pointer-coarse:py-2"
        >
          {expanded
            ? t('common:coworkBars.showFewer')
            : t('common:coworkBars.showMore', { count: extra })}
        </button>
      )}
    </div>
  )
}
