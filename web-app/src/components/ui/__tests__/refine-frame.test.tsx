import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RefineFrame } from '../refine-frame'

describe('RefineFrame', () => {
  it('shows a shimmer and a chip while nothing has arrived', () => {
    render(<RefineFrame src={null} alt="a cat" status="queued" />)
    expect(screen.getByTestId('refine-frame-shimmer')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Queued' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
  })

  it('labels each state and stops the job', () => {
    const onStop = vi.fn()
    const { rerender } = render(
      <RefineFrame
        src="x.png"
        alt="a cat"
        status="generating"
        fraction={0.3}
        onStop={onStop}
        detail="Drawing · 30%"
      />
    )
    expect(screen.getByTestId('refine-frame-chip')).toHaveTextContent(
      'Generating'
    )
    expect(screen.getByText('Drawing · 30%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(onStop).toHaveBeenCalledTimes(1)
    rerender(
      <RefineFrame
        src="x.png"
        alt="a cat"
        status="refining"
        fraction={0.9}
        onStop={onStop}
      />
    )
    expect(screen.getByTestId('refine-frame-chip')).toHaveTextContent(
      'Refining'
    )
    rerender(
      <RefineFrame src="x.png" alt="a cat" status="complete" onStop={onStop} />
    )
    expect(screen.getByTestId('refine-frame-chip')).toHaveTextContent('Ready')
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()
    expect(screen.getByTestId('refine-frame')).not.toHaveAttribute('aria-busy')
  })

  it('offers retry on failure', () => {
    const onRetry = vi.fn()
    render(
      <RefineFrame src="x.png" alt="a cat" status="error" onRetry={onRetry} />
    )
    expect(screen.getByTestId('refine-frame-chip')).toHaveTextContent('Failed')
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
