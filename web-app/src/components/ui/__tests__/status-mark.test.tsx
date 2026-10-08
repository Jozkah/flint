import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusMark, type StatusMarkState } from '../status-mark'

describe('StatusMark', () => {
  const states: StatusMarkState[] = [
    'pending',
    'running',
    'done',
    'failed',
    'cancelled',
  ]

  it.each(states)('reports the %s state', (status) => {
    render(<StatusMark status={status} />)
    expect(screen.getByTestId('status-mark')).toHaveAttribute(
      'data-status',
      status
    )
  })

  it('is decorative without a label and an image with one', () => {
    const { rerender } = render(<StatusMark status="done" />)
    expect(screen.getByTestId('status-mark')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
    rerender(<StatusMark status="done" ariaLabel="Done" />)
    expect(screen.getByRole('img', { name: 'Done' })).toBeInTheDocument()
  })

  it('draws the check only when done and the cross when failed or cancelled', () => {
    const { container, rerender } = render(<StatusMark status="done" />)
    const part = (n: string) => container.querySelector(`[data-part="${n}"]`)!
    expect(part('check').getAttribute('class')).toContain('stroke-dashoffset:0')
    expect(part('cross').getAttribute('class')).toContain(
      'stroke-dashoffset:1.05'
    )
    rerender(<StatusMark status="failed" />)
    expect(part('cross').getAttribute('class')).toContain('stroke-dashoffset:0')
    rerender(<StatusMark status="cancelled" />)
    expect(part('cross').getAttribute('class')).toContain('stroke-dashoffset:0')
    expect(part('check').getAttribute('class')).toContain(
      'stroke-dashoffset:1.05'
    )
  })

  it('strikes the label through once done', () => {
    const { rerender } = render(<StatusMark status="running" label="Build" />)
    expect(screen.getByTestId('status-mark-strike')).toHaveAttribute(
      'data-drawn',
      'false'
    )
    rerender(<StatusMark status="done" label="Build" />)
    expect(screen.getByTestId('status-mark-strike')).toHaveAttribute(
      'data-drawn',
      'true'
    )
    expect(screen.getByText('Build')).toBeInTheDocument()
  })
})
