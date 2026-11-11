import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { createFakeApi, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomComposer } from '../RoomComposer'
import { mentionAt, mentionedTarget } from '@/lib/rooms/mentions'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsT')
  return { useTranslation: () => ({ t: u.t }), i18n: { t: u.t } }
})
vi.mock('@/lib/slashCatalog', () => ({
  loadSlashCatalog: vi.fn(async () => []),
  invokeSlashSkill: vi.fn(),
}))

describe('room @ mentions', () => {
  it('opens the participant list on @, filters, picks with the keyboard and addresses the pick', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    const box = screen.getByLabelText('Message to the room')

    await user.type(box, '@')
    const list = screen.getByTestId('room-mention-list')
    expect(list).toHaveTextContent('Alice')
    expect(list).toHaveTextContent('Bob')
    await user.type(box, 'b')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Enter}')
    expect(box).toHaveValue('@Bob ')
    expect(screen.queryByTestId('room-mention-list')).toBeNull()
    await user.type(box, 'what do you think?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(controller.sendUserMessage).toHaveBeenCalledWith('r1', '@Bob what do you think?', {
        kind: 'participant',
        participantId: 'p2',
      })
    )
  })

  it('a typed @Name to everyone goes to that participant', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    const box = screen.getByLabelText('Message to the room')
    await user.type(box, '@Alice')
    await user.keyboard('{Escape}')
    await user.type(box, ', your view?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(controller.sendUserMessage).toHaveBeenCalledWith('r1', '@Alice, your view?', {
        kind: 'participant',
        participantId: 'p1',
      })
    )
  })

  it('parses mentions conservatively', () => {
    const targets = [
      { value: 'participant:a', label: 'Bob' },
      { value: 'participant:b', label: 'Bob Smith' },
    ]
    expect(mentionedTarget('@Bob Smith hi', targets)?.value).toBe('participant:b')
    expect(mentionedTarget('@bob hi', targets)?.value).toBe('participant:a')
    expect(mentionedTarget('@Bobby hi', targets)).toBeNull()
    expect(mentionedTarget('hi @Bob', targets)).toBeNull()
    expect(mentionAt('mail a@b', 8)).toBeNull()
    expect(mentionAt('hi @Al', 6)).toEqual({ start: 3, query: 'Al' })
  })
})
