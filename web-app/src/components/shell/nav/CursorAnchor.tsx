import { forwardRef, useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type CursorPoint = { x: number; y: number }

/**
 * A zero-size anchor at a screen point, for a menu opened by right-click to
 * open where the pointer is. Portalled to <body> so the app's CSS zoom does
 * not shift it; used as a `DropdownMenuTrigger asChild` child.
 */
export const CursorAnchor = forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & CursorPoint
>(function CursorAnchor({ x, y, ...rest }, ref) {
  return createPortal(
    <span
      ref={ref}
      {...rest}
      aria-hidden
      style={{
        position: 'fixed',
        left: x,
        top: y,
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    />,
    document.body
  )
})

/** Where a row's menu was asked for, if by pointer; null for the keyboard. */
export function useCursorAnchor() {
  const [point, setPoint] = useState<CursorPoint | null>(null)
  const gen = useRef(0)

  const openAt = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    gen.current++
    setPoint('clientX' in e ? { x: e.clientX, y: e.clientY } : null)
  }, [])

  /** Keep the anchor through the close animation, then drop it. */
  const release = useCallback(() => {
    const g = gen.current
    setTimeout(() => {
      if (gen.current === g) setPoint(null)
    }, 200)
  }, [])

  return { point, openAt, release }
}
