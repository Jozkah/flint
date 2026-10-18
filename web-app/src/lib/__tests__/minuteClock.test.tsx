import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { minuteClockState, useMinuteClock } from '@/lib/minuteClock'
import { useThreadStatus } from '@/containers/ThreadStatusMark'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setHidden(hidden: boolean) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('shared minute clock', () => {
  it('2,000 status rows share one interval instead of one each', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(window, 'setInterval')
    const spyGlobal = vi.spyOn(globalThis, 'setInterval')
    function Row({ i }: { i: number }) {
      return <span>{useThreadStatus({ updated: Date.now() - i * 1000 }, false)}</span>
    }
    const { unmount } = render(
      <>
        {Array.from({ length: 2000 }, (_, i) => (
          <Row key={i} i={i} />
        ))}
      </>
    )
    const calls = new Set([...spy.mock.calls, ...spyGlobal.mock.calls].map((c) => c[1]))
    expect(spy.mock.calls.length + spyGlobal.mock.calls.length).toBeLessThanOrEqual(2)
    expect([...calls]).toEqual([60_000])
    expect(minuteClockState()).toEqual({ listeners: 2000, armed: true })
    unmount()
    expect(minuteClockState()).toEqual({ listeners: 0, armed: false })
  })

  it('re-renders a row only when its selected value flips', () => {
    vi.useFakeTimers()
    const start = Date.now()
    let renders = 0
    function Probe() {
      renders++
      return <span>{String(useMinuteClock((now) => now - start < 3 * 60_000))}</span>
    }
    const { container, unmount } = render(<Probe />)
    const base = renders
    act(() => vi.advanceTimersByTime(60_000))
    act(() => vi.advanceTimersByTime(60_000))
    expect(renders).toBe(base)
    expect(container.textContent).toBe('true')
    act(() => vi.advanceTimersByTime(2 * 60_000))
    expect(container.textContent).toBe('false')
    expect(renders).toBe(base + 1)
    unmount()
  })

  it('does not tick while the window is hidden and catches up on show', () => {
    vi.useFakeTimers()
    const start = Date.now()
    function Probe() {
      return <span>{String(useMinuteClock((now) => now - start < 90_000))}</span>
    }
    const { container, unmount } = render(<Probe />)
    act(() => setHidden(true))
    expect(minuteClockState().armed).toBe(false)
    act(() => vi.advanceTimersByTime(5 * 60_000))
    expect(container.textContent).toBe('true')
    act(() => setHidden(false))
    expect(minuteClockState().armed).toBe(true)
    expect(container.textContent).toBe('false')
    unmount()
  })
})
