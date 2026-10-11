import { checkOSDarkMode } from '@/hooks/useTheme'

export type ThemeChoice = 'auto' | 'light' | 'dark'

/**
 * Switch theme with the design's reveal: the new theme opens as a circle from
 * `from` (View Transitions), or switches at once without motion.
 */
export function switchTheme(
  from: HTMLElement,
  next: ThemeChoice,
  setTheme: (t: ThemeChoice) => unknown
) {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> }
  }
  const root = document.documentElement
  const reduce = root.classList.contains('reduce-motion')
  if (reduce || !doc.startViewTransition) {
    void setTheme(next)
    return
  }
  const nextDark = next === 'auto' ? checkOSDarkMode() : next === 'dark'
  const r = from.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  root.classList.add('vt-theme')
  const t = doc.startViewTransition(() => {
    void setTheme(next)
    root.classList.toggle('dark', nextDark)
  })
  t.ready
    .then(() =>
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
        { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::view-transition-new(root)' }
      )
    )
    .catch(() => {})
  t.finished.finally(() => root.classList.remove('vt-theme'))
}
