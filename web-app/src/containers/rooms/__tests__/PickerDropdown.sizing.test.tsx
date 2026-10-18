import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { PickerDropdown } from '../PickerDropdown'

const groups = [
  { label: 'A', items: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
]

describe('PickerDropdown sizing', () => {
  it('keeps the menu compact, bound by the trigger width and available height', async () => {
    render(<PickerDropdown value={null} groups={groups} placeholder="pick" onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement
    expect(menu.className).toContain('min(20rem,var(--radix-dropdown-menu-content-available-height))')
    expect(menu.className).toContain('w-(--radix-dropdown-menu-trigger-width)')
    expect(menu.className).toContain('min-w-[280px]')
    expect(menu.className).toContain('max-w-[380px]')
    expect(menu.className).not.toContain('32rem')
  })

  it('uses compact rows', async () => {
    render(<PickerDropdown value={null} groups={groups} placeholder="pick" onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const row = (await screen.findAllByRole('menuitemradio'))[0]
    expect(row.className).toContain('py-1.5')
    expect(row.className).not.toContain('py-2')
  })
})
