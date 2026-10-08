import { act } from '@testing-library/react'

/** jsdom has no PointerEvent: a MouseEvent carrying the pointer fields. */
export function pointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { x: number; y?: number; id?: number; t?: number }
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y ?? 0,
    button: 0,
  })
  Object.defineProperty(ev, 'pointerId', { value: init.id ?? 1 })
  if (init.t !== undefined)
    Object.defineProperty(ev, 'timeStamp', { value: init.t })
  act(() => {
    el.dispatchEvent(ev)
  })
}

let clock = 0
/** Presses, moves through the x positions 16ms apart, and releases. */
export function dragX(
  el: Element,
  xs: number[],
  y = 0,
  release = true,
  gap = 16
) {
  pointer(el, 'pointerdown', { x: xs[0], y, t: (clock += gap) })
  xs.slice(1).forEach((x) =>
    pointer(el, 'pointermove', { x, y, t: (clock += gap) })
  )
  if (release)
    pointer(el, 'pointerup', { x: xs[xs.length - 1], y, t: (clock += gap) })
}
