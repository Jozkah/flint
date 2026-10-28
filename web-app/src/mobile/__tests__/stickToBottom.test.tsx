import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { isNearBottom, useStickToBottom } from '../ui/hooks'

describe('isNearBottom', () => {
  it('is true within the threshold and false above it', () => {
    expect(isNearBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80 })).toBe(true)
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 80 })).toBe(false)
  })
})

describe('useStickToBottom', () => {
  function setup() {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
    el.scrollTop = 0
    const hook = renderHook(
      ({ dep }) => {
        const ref = useStickToBottom(dep)
        if (!ref.current) (ref as { current: HTMLDivElement | null }).current = el
        return ref
      },
      { initialProps: { dep: 0 } }
    )
    return { el, hook }
  }

  it('pins to the bottom while following', () => {
    const { el, hook } = setup()
    hook.rerender({ dep: 1 })
    expect(el.scrollTop).toBe(1000)
  })

  it('leaves a reader who scrolled up alone', () => {
    const { el, hook } = setup()
    hook.rerender({ dep: 1 }) // attaches the listener on the first effect run with the element
    el.scrollTop = 200
    el.dispatchEvent(new Event('scroll'))
    hook.rerender({ dep: 2 })
    expect(el.scrollTop).toBe(200)
  })
})
