import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { PickerDropdown } from '../PickerDropdown'

const groups = [
  { label: 'A', items: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
]

describe('PickerDropdown sizing', () => {
  it('is exactly the trigger width, bound by the screen and the available height', async () => {
    render(<PickerDropdown value={null} groups={groups} placeholder="pick" onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement
    expect(menu.className).toContain('min(20rem,var(--radix-dropdown-menu-content-available-height))')
    expect(menu.className).toContain('w-(--radix-dropdown-menu-trigger-width)')
    expect(menu.className).toContain('min-w-(--radix-dropdown-menu-trigger-width)')
    expect(menu.className).toContain(
      'max-w-[min(var(--radix-dropdown-menu-trigger-width),calc(100vw-1.5rem))]'
    )
    // No fixed pixel floor or ceiling: those are what made it differ from the field.
    expect(menu.className).not.toMatch(/min-w-\[\d/)
    expect(menu.className).not.toMatch(/max-w-\[\d/)
    expect(menu.className).toContain('rounded-lg')
  })

  it('opens left-aligned under the field with an 8px gap', async () => {
    render(<PickerDropdown value={null} groups={groups} placeholder="pick" onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement
    expect(menu.getAttribute('data-align')).toBe('start')
    expect(menu.getAttribute('data-side')).toBe('bottom')
  })

  it('uses compact rows', async () => {
    render(<PickerDropdown value={null} groups={groups} placeholder="pick" onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const row = (await screen.findAllByRole('menuitemradio'))[0]
    expect(row.className).toContain('py-1.5')
    expect(row.className).not.toContain('py-2')
  })
})
