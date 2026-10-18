import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { createSharedClock, secondClock, useSecondClock } from '@/lib/sharedClock'

afterEach(() => vi.useRealTimers())

describe('shared second clock', () => {
  it('runs one timer for every counter and stops with the last one', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setInterval')
    let renders = 0
    function Counter() {
      renders++
      const now = useSecondClock(true)
      return <span>{now}</span>
    }
    const view = render(
      <>
        <Counter />
        <Counter />
        <Counter />
      </>
    )
    expect(secondClock.state()).toEqual({ listeners: 3, armed: true })
    expect(spy).toHaveBeenCalledTimes(1)
    const before = renders
    act(() => vi.advanceTimersByTime(1000))
    expect(renders - before).toBe(3)
    view.unmount()
    expect(secondClock.state()).toEqual({ listeners: 0, armed: false })
    spy.mockRestore()
  })

  it('a disabled counter neither subscribes nor re-renders', () => {
    vi.useFakeTimers()
    let renders = 0
    function Counter() {
      renders++
      useSecondClock(false)
      return null
    }
    render(<Counter />)
    const before = renders
    act(() => vi.advanceTimersByTime(5000))
    expect(renders).toBe(before)
    expect(secondClock.state().listeners).toBe(0)
  })

  it('does not tick while the window is hidden and catches up when shown', () => {
    vi.useFakeTimers()
    const clock = createSharedClock(1000)
    const listener = vi.fn()
    const off = clock.subscribe(listener)
    const vis = vi.spyOn(document, 'visibilityState', 'get')
    vis.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(clock.state().armed).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(listener).not.toHaveBeenCalled()
    vis.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(clock.state().armed).toBe(true)
    off()
    vis.mockRestore()
  })
})
