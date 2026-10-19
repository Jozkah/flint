import { describe, it, expect, vi } from 'vitest'
import { revealInScroller } from '../revealInScroller'

const rect = (top: number, bottom: number) =>
  ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect

describe('revealInScroller', () => {
  it('scrolls the nearest scrollable ancestor and never the overflow-hidden one', () => {
    const hidden = document.createElement('div')
    hidden.style.overflowY = 'hidden'
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const el = document.createElement('div')
    hidden.append(scroller)
    scroller.append(el)
    document.body.append(hidden)
    scroller.getBoundingClientRect = () => rect(0, 100)
    el.getBoundingClientRect = () => rect(150, 180)
    const spy = vi.fn()
    el.scrollIntoView = spy
    hidden.scrollTop = 0

    revealInScroller(el, false)

    expect(spy).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(80)
    expect(hidden.scrollTop).toBe(0)
  })

  it('does nothing when already visible', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const el = document.createElement('div')
    scroller.append(el)
    document.body.append(scroller)
    scroller.getBoundingClientRect = () => rect(0, 100)
    el.getBoundingClientRect = () => rect(10, 30)
    revealInScroller(el, false)
    expect(scroller.scrollTop).toBe(0)
  })
})
