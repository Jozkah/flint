import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** True when the OS asks for reduced motion or Flint's own Reduce motion
 * setting put `reduce-motion` on the root element. */
export function readReducedMotion(): boolean {
  if (
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('reduce-motion')
  )
    return true
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(QUERY)?.matches === true
  )
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    const update = () => setReduced(readReducedMotion())
    const mq =
      typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
    mq?.addEventListener?.('change', update)
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => {
      mq?.removeEventListener?.('change', update)
      mo.disconnect()
    }
  }, [])
  return reduced
}
