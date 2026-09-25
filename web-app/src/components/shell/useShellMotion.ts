import { useEffect, useRef, useState, type RefObject } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

/** Selectors for controls that answer a press with a ripple. */
const RIPPLE = '[data-slot="button"][data-variant="default"], [data-ripple]'

/**
 * The shell's own motion, as the design has it: the sidebar and header enter
 * once at start-up, each navigation fades the page in, and primary buttons
 * ripple from the pointer. Everything stops with Reduce motion on.
 */
export function useShellMotion(pageRef: RefObject<HTMLElement | null>) {
  const reduce = useInterfaceSettings((s) => s.reduceMotion)
  const { pathname } = useLocation()
  const [booting, setBooting] = useState(true)
  const first = useRef(true)

  useEffect(() => {
    const id = window.setTimeout(() => setBooting(false), 1200)
    return () => window.clearTimeout(id)
  }, [])

  // Replay the page fade on every navigation, without remounting the page.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const el = pageRef.current
    if (!el || reduce) return
    el.classList.remove('view-in')
    void el.offsetWidth
    el.classList.add('view-in')
    const id = window.setTimeout(() => el.classList.remove('view-in'), 320)
    return () => window.clearTimeout(id)
  }, [pathname, pageRef, reduce])

  useEffect(() => {
    if (reduce) return
    const onDown = (e: PointerEvent) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(RIPPLE)
      if (!target || (target as HTMLButtonElement).disabled) return
      const r = target.getBoundingClientRect()
      const dot = document.createElement('span')
      dot.className = 'ripple'
      dot.style.left = `${e.clientX - r.left}px`
      dot.style.top = `${e.clientY - r.top}px`
      target.appendChild(dot)
      window.setTimeout(() => dot.remove(), 600)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [reduce])

  return { booting: booting && !reduce }
}
