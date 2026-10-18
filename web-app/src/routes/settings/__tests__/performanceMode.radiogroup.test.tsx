import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { PerformanceModeSetting } from '../interface'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

describe('Performance mode radiogroup', () => {
  beforeEach(() => {
    useInterfaceSettings.getState().setPerformanceMode('auto')
  })

  it('has one tab stop and moves the selection with arrow keys, Home and End', async () => {
    const user = userEvent.setup()
    render(<PerformanceModeSetting />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    // One tab stop for the whole group (Radix keeps the radios at -1 until
    // one is focused, and the group forwards focus to the checked radio).
    const group = screen.getByRole('radiogroup')
    const stops = [group, ...radios].filter((el) => el.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true')!
    expect(checked).toHaveAttribute('data-mode', 'auto')

    await user.tab()
    expect(document.activeElement).toBe(checked)
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(radios[1])
    expect(useInterfaceSettings.getState().performanceMode).toBe(radios[1]!.getAttribute('data-mode'))
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(radios[2])
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(radios[0])
    expect(useInterfaceSettings.getState().performanceMode).toBe('auto')
  })

  it('selects a mode on click', () => {
    render(<PerformanceModeSetting />)
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    expect(useInterfaceSettings.getState().performanceMode).toBe(
      screen.getAllByRole('radio')[1]!.getAttribute('data-mode')
    )
  })
})
