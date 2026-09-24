import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { createFakeApi, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomComposer } from '../RoomComposer'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})

vi.mock('@/lib/slashCatalog', () => ({
  loadSlashCatalog: vi.fn(async () => [
    {
      kind: 'command',
      name: 'debate',
      plugin: 'rooms-kit',
      description: 'Start a debate',
      scope: 'global',
      body: 'Debate the motion: $ARGUMENTS',
    },
  ]),
  invokeSlashSkill: vi.fn(),
}))

import { loadSlashCatalog } from '@/lib/slashCatalog'

describe('RoomComposer slash commands', () => {
  it('reads the Rooms catalog, offers the menu and sends the expansion to the room', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    await waitFor(() => expect(loadSlashCatalog).toHaveBeenCalledWith('rooms', undefined))
    const box = screen.getByLabelText('Message to the room')

    await user.type(box, '/deb')
    expect(screen.getByTestId('slash-menu')).toBeInTheDocument()
    // Enter picks from the menu rather than inserting a newline.
    await user.keyboard('{Enter}')
    expect(box).toHaveValue('/debate ')
    await user.type(box, 'cats vs dogs')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(controller.sendUserMessage).toHaveBeenCalled())
    const [roomId, text, to] = vi.mocked(controller.sendUserMessage).mock.calls[0]
    expect(roomId).toBe('r1')
    expect(to).toEqual({ kind: 'room' })
    expect(text).toContain('Debate the motion: cats vs dogs')
    expect(text.startsWith('<!-- flint:slash ')).toBe(true)
    expect(box).toHaveValue('')
  })

  it('sends an unknown slash message as typed', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    await user.type(screen.getByLabelText('Message to the room'), '/tmp/notes.txt is where it lives')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(controller.sendUserMessage).toHaveBeenCalledWith(
        'r1',
        '/tmp/notes.txt is where it lives',
        { kind: 'room' }
      )
    )
  })
})
