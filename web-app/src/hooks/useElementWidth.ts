import { useEffect, useState, type RefObject } from 'react'

const windowWidth = () =>
  typeof window === 'undefined' ? 0 : window.innerWidth

/**
 * The rendered width of an element, kept current as it resizes. Where there
 * is no ResizeObserver it falls back to the window's width.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(windowWidth)

  useEffect(() => {
    const el = ref.current
    if (el && typeof ResizeObserver !== 'undefined') {
      const measure = () => setWidth(el.getBoundingClientRect().width)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      return () => observer.disconnect()
    }
    const onResize = () => setWidth(windowWidth())
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [ref])

  return width
}
