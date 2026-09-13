/**
 * The command palette: opens, ranks locally, runs what is chosen, and closes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k.split(/[:.]/).pop() ?? k }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: (sel: (s: unknown) => unknown) =>
    sel({
      threads: {
        a: { id: 'a', title: 'Trip planning', updated: 2 },
        b: { id: 'b', title: 'Budget review', updated: 1 },
      },
    }),
}))
const setSearchOpen = vi.fn()
vi.mock('@/hooks/useSearchDialog', () => ({
  useSearchDialog: { getState: () => ({ setOpen: setSearchOpen }) },
}))

import { CommandPalette, useCommandPalette } from '../CommandPalette'

beforeEach(() => {
  navigate.mockReset()
  setSearchOpen.mockReset()
  act(() => useCommandPalette.getState().setOpen(true))
})

describe('CommandPalette', () => {
  it('lists actions, navigation, conversations and settings when opened', async () => {
    render(<CommandPalette />)
    const ids = (await screen.findAllByTestId('command-palette-item')).map(
      (e) => e.getAttribute('data-command')
    )
    expect(ids).toContain('action-new-chat')
    expect(ids).toContain('nav-cowork')
    expect(ids).toContain('thread-a')
    expect(ids.some((id) => id?.startsWith('settings-'))).toBe(true)
  })

  it('runs the best match on Enter and closes', async () => {
    render(<CommandPalette />)
    await userEvent.type(
      screen.getByTestId('command-palette-input'),
      'budget{Enter}'
    )
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: 'b' } })
    )
    expect(useCommandPalette.getState().open).toBe(false)
  })

  it('moves the selection with the arrow keys', async () => {
    render(<CommandPalette />)
    const input = screen.getByTestId('command-palette-input')
    // Nothing typed: actions first, in declared order.
    const items = await screen.findAllByTestId('command-palette-item')
    expect(items[0].getAttribute('aria-selected')).toBe('true')
    expect(items[2].getAttribute('data-command')).toBe('action-search-threads')
    await userEvent.type(input, '{ArrowDown}{ArrowDown}')
    expect(
      screen
        .getAllByTestId('command-palette-item')[2]
        .getAttribute('aria-selected')
    ).toBe('true')
    await userEvent.type(input, '{ArrowUp}{ArrowDown}{Enter}')
    expect(setSearchOpen).toHaveBeenCalledWith(true)
  })

  it('says so when nothing matches', async () => {
    render(<CommandPalette />)
    await userEvent.type(
      screen.getByTestId('command-palette-input'),
      'zzzzqqqq'
    )
    expect(screen.queryAllByTestId('command-palette-item')).toHaveLength(0)
    expect(screen.getByText('empty')).toBeInTheDocument()
  })
})
