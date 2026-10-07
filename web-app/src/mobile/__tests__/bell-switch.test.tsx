import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { BellSwitch } from '../ui/bell-switch'

function Harness({ initial = false }: { initial?: boolean }) {
  const [on, setOn] = useState(initial)
  return (
    <BellSwitch
      label="Notify this phone"
      on={on}
      testId="push-toggle"
      onClick={() => setOn((v) => !v)}
    />
  )
}

afterEach(() => document.documentElement.classList.remove('reduce-motion'))

describe('BellSwitch', () => {
  it('is a switch that flips and crossfades its line', () => {
    render(<Harness />)
    const sw = screen.getByTestId('push-toggle')
    expect(sw).toHaveAttribute('role', 'switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(sw).toHaveTextContent('Off')
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveAttribute('data-on', 'true')
    expect(sw).toHaveTextContent('You’ll be notified')
  })

  it('rings the bell only when the tap turns it on', () => {
    const { container } = render(<Harness />)
    expect(container.querySelector('.bs-glyph[data-ring]')).toBeNull()
    fireEvent.click(screen.getByTestId('push-toggle'))
    expect(container.querySelector('.bs-glyph[data-ring]')).not.toBeNull()
    expect(container.querySelectorAll('.bs-wave')).toHaveLength(2)
  })

  it('does not ring for a state that was already on, or when turned off', () => {
    const { container } = render(<Harness initial />)
    expect(container.querySelector('.bs-glyph[data-ring]')).toBeNull()
    fireEvent.click(screen.getByTestId('push-toggle'))
    expect(screen.getByTestId('push-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(container.querySelector('.bs-glyph[data-ring]')).toBeNull()
  })

  it('stays still when motion is reduced', () => {
    document.documentElement.classList.add('reduce-motion')
    const { container } = render(<Harness />)
    fireEvent.click(screen.getByTestId('push-toggle'))
    expect(screen.getByTestId('push-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(container.querySelector('.bs-glyph[data-ring]')).toBeNull()
  })

  it('keeps its own sub text and ignores clicks when it has no handler', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <BellSwitch
        label="Notify"
        on={false}
        sub="Not set up on the computer"
        testId="t"
      />
    )
    expect(screen.getByTestId('t')).toHaveTextContent(
      'Not set up on the computer'
    )
    expect(screen.getByTestId('t')).not.toHaveTextContent('Off')
    fireEvent.click(screen.getByTestId('t'))
    expect(onClick).not.toHaveBeenCalled()
    rerender(
      <BellSwitch label="Notify" on={false} onClick={onClick} testId="t" busy />
    )
    fireEvent.click(screen.getByTestId('t'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('t')).toHaveAttribute('aria-busy', 'true')
  })
})
