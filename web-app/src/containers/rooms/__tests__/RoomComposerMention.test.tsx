import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
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

  it('a typed @Name moves the address chip before sending, so the target is visible', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    const box = screen.getByLabelText('Message to the room')
    await user.type(box, '@Alice')
    await user.keyboard('{Escape}')
    await user.type(box, ', your view?')
    expect(screen.getByRole('radio', { name: 'Alice' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(controller.sendUserMessage).toHaveBeenCalledWith('r1', '@Alice, your view?', {
        kind: 'participant',
        participantId: 'p1',
      })
    )
  })

  it('leaves an address chip the user picked alone', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    await user.click(screen.getByRole('radio', { name: 'Everyone' }))
    const box = screen.getByLabelText('Message to the room')
    await user.type(box, '@Bob')
    await user.keyboard('{Escape}')
    await user.type(box, ' and all of you')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(controller.sendUserMessage).toHaveBeenCalledWith('r1', '@Bob and all of you', { kind: 'room' })
    )
  })

  it('does not pick while an IME is composing', () => {
    const { api } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    const box = screen.getByLabelText('Message to the room')
    fireEvent.change(box, { target: { value: '@', selectionStart: 1 } })
    expect(screen.getByTestId('room-mention-list')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229, isComposing: true })
    expect(box).toHaveValue('@')
    expect(screen.getByTestId('room-mention-list')).toBeInTheDocument()
  })

  it('closes the list when the caret moves away and never splices into stale text', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    const box = screen.getByLabelText('Message to the room') as HTMLTextAreaElement
    await user.type(box, 'hi @Al')
    expect(screen.getByTestId('room-mention-list')).toBeInTheDocument()
    box.setSelectionRange(1, 1)
    fireEvent.select(box)
    expect(screen.queryByTestId('room-mention-list')).toBeNull()
    await user.keyboard('{Enter}')
    expect(box.value).not.toContain('Alice')
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
