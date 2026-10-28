import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ModelLoader } from '../ModelLoader'

describe('ModelLoader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows a live timer while loading', () => {
    render(<ModelLoader />)
    expect(screen.getByText('common:modelLoader.loading')).toBeInTheDocument()
    expect(screen.getByTestId('model-loader-elapsed')).toHaveTextContent('0s')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByTestId('model-loader-elapsed')).toHaveTextContent('3s')
  })

  it('freezes the timer when done', () => {
    const { rerender } = render(<ModelLoader />)
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    rerender(<ModelLoader status="done" />)
    expect(screen.getByText('common:modelLoader.done')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByTestId('model-loader-elapsed')).toHaveTextContent('4s')
    expect(screen.getByTestId('model-loader')).toHaveAttribute(
      'data-status',
      'done'
    )
  })

  it('shows the failed state with a pinned duration', () => {
    render(<ModelLoader status="failed" elapsedMs={4200} />)
    expect(screen.getByText('common:modelLoader.failed')).toBeInTheDocument()
    expect(screen.getByTestId('model-loader-elapsed')).toHaveTextContent('4s')
  })
})
