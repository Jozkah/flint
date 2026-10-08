import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Tooltip, TooltipTrigger, TooltipContent } from '../tooltip'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Pair() {
  return (
    <div>
      <Tooltip>
        <TooltipTrigger>First</TooltipTrigger>
        <TooltipContent>First tip</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger>Second</TooltipTrigger>
        <TooltipContent>Second tip</TooltipContent>
      </Tooltip>
    </div>
  )
}

const hover = (el: HTMLElement) =>
  fireEvent.pointerMove(el, { pointerType: 'mouse' })
const leave = (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Escape' })

describe('Tooltip warm behaviour', () => {
  beforeEach(() => {
    global.ResizeObserver = MockResizeObserver
    vi.stubEnv('MODE', 'production')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('waits 400 ms for the first tooltip', () => {
    render(<Pair />)
    hover(screen.getByText('First'))
    act(() => {
      vi.advanceTimersByTime(399)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('First tip')
  })

  it('opens the neighbour at once while warm, then cools down', () => {
    render(<Pair />)
    hover(screen.getByText('First'))
    act(() => {
      vi.advanceTimersByTime(401)
    })
    leave(screen.getByText('First'))
    act(() => {
      vi.advanceTimersByTime(100)
    })
    hover(screen.getByText('Second'))
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getAllByText('Second tip').length).toBeGreaterThan(0)
    leave(screen.getByText('Second'))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    hover(screen.getByText('First'))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByText('First tip')).toBeNull()
  })

  it('closes on Escape', () => {
    render(<Pair />)
    const trigger = screen.getByText('First')
    hover(trigger)
    act(() => {
      vi.advanceTimersByTime(401)
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
