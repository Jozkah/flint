/**
 * The command palette: opens, ranks locally, runs what is chosen, and closes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { item?: string }) => {
      if (k === 'common:translate.title') return 'Translate'
      const last = k.split(/[:.]/).pop() ?? k
      return o?.item ? `${last} ${o.item}` : last
    },
  }),
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
import { hiddenForPreset, hideableSidebarIds } from '@/lib/sidebarItems'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

beforeEach(() => {
  navigate.mockReset()
  setSearchOpen.mockReset()
  useInterfaceSettings.setState({ hiddenNavItems: [] })
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

  it('keeps every page the sidebar can hide one entry away', async () => {
    render(<CommandPalette />)
    const ids = (await screen.findAllByTestId('command-palette-item')).map(
      (e) => e.getAttribute('data-command')
    )
    for (const id of hideableSidebarIds()) {
      // Library has its own entry, routed to the same page.
      if (id === 'library') continue
      expect(ids).toContain(`nav-${id}`)
    }
  })

  it('finds a hidden page by part of its name and opens it', async () => {
    useInterfaceSettings.setState({ hiddenNavItems: hiddenForPreset('minimal') })
    render(<CommandPalette />)
    await userEvent.type(screen.getByTestId('command-palette-input'), 'transl')
    const first = screen.getAllByTestId('command-palette-item')[0]
    expect(first.getAttribute('data-command')).toBe('nav-translate')
    await userEvent.type(screen.getByTestId('command-palette-input'), '{Enter}')
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/translate' }))
  })

  it('lists Rooms, and shows or hides a page in the sidebar', async () => {
    useInterfaceSettings.setState({ hiddenNavItems: ['studio'] })
    render(<CommandPalette />)
    const ids = (await screen.findAllByTestId('command-palette-item')).map(
      (e) => e.getAttribute('data-command')
    )
    expect(ids).toContain('nav-rooms')
    await userEvent.type(
      screen.getByTestId('command-palette-input'),
      'showItem studio{Enter}'
    )
    expect(useInterfaceSettings.getState().hiddenNavItems).toEqual([])
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

  it('ignores Enter while an IME composition is active', async () => {
    render(<CommandPalette />)
    const input = screen.getByTestId('command-palette-input')
    await screen.findAllByTestId('command-palette-item')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(navigate).not.toHaveBeenCalled()
    expect(setSearchOpen).not.toHaveBeenCalled()
    expect(useCommandPalette.getState().open).toBe(true)
  })

  it('scrolls the newly highlighted row into view', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    render(<CommandPalette />)
    await screen.findAllByTestId('command-palette-item')
    scroll.mockClear()
    await userEvent.type(screen.getByTestId('command-palette-input'), '{ArrowDown}')
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
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
