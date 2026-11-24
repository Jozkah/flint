import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { createFakeApi, makeParticipant, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomPermissionMenu } from '../RoomPermissionMenu'
import { RoomComposer } from '../RoomComposer'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsT')
  return { useTranslation: () => ({ t: u.t }), i18n: { t: u.t } }
})
vi.mock('@/lib/slashCatalog', () => ({
  loadSlashCatalog: vi.fn(async () => []),
  invokeSlashSkill: vi.fn(),
}))

const user = userEvent.setup({ pointerEventsCheck: 0 })
const writer = (id: string, over = {}) => makeParticipant(id, { toolAccess: 'full', ...over })

describe('RoomPermissionMenu', () => {
  it("shows the room's mode (Ask by default) and saves a new one with the room", async () => {
    const { api } = createFakeApi()
    const room = makeRoom({ folder: 'C:/proj', participants: [writer('p1')] })
    renderWithApi(<RoomPermissionMenu room={room} />, api)
    const trigger = screen.getByTestId('cowork-mode-selector')
    expect(trigger).toHaveTextContent('common:coworkMode.ask.short')
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitemradio', { name: /coworkMode\.auto\.label/ }))
    await waitFor(() =>
      expect(api.updateRoomSettings).toHaveBeenCalledWith(room, { permissionMode: 'auto' })
    )
  })

  it("sets one participant's own mode, and can hand it back to the room", async () => {
    const { api } = createFakeApi()
    const p = writer('p1', { permissionMode: 'review' })
    const room = makeRoom({ folder: 'C:/proj', permissionMode: 'auto', participants: [p] })
    renderWithApi(<RoomPermissionMenu room={room} participant={p} />, api)
    expect(screen.getByTestId('cowork-mode-selector')).toHaveTextContent('common:coworkMode.review.short')
    await user.click(screen.getByTestId('participant-permission-reset'))
    await waitFor(() =>
      expect(api.updateRoomSettings).toHaveBeenCalledWith(room, {
        participants: [{ id: 'p1', permissionMode: null }],
      })
    )
  })

  it("shows the room's mode for a participant with none of its own", () => {
    const { api } = createFakeApi()
    const p = writer('p1')
    const room = makeRoom({ permissionMode: 'bypass', participants: [p] })
    renderWithApi(<RoomPermissionMenu room={room} participant={p} />, api)
    expect(screen.getByTestId('cowork-mode-selector')).toHaveTextContent('common:coworkMode.bypass.short')
    expect(screen.getByText('Using the room\'s mode')).toBeInTheDocument()
  })

  it('is disabled while the room runs, and says to pause first', () => {
    const { api } = createFakeApi()
    const room = makeRoom({ status: 'running', folder: 'C:/proj', participants: [writer('p1')] })
    renderWithApi(<RoomPermissionMenu room={room} />, api)
    const trigger = screen.getByTestId('cowork-mode-selector')
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('title', 'Pause the room to change what it may do.')
  })
})

describe('the composer', () => {
  it('offers the menu only when a folder is attached and someone can change files', () => {
    const { api } = createFakeApi()
    const view = renderWithApi(
      <RoomComposer room={makeRoom({ folder: 'C:/proj', participants: [writer('p1')] })} />,
      api
    )
    expect(screen.getByTestId('room-permission')).toBeInTheDocument()
    view.unmount()
    renderWithApi(<RoomComposer room={makeRoom({ folder: null, participants: [writer('p1')] })} />, api)
    expect(screen.queryByTestId('room-permission')).toBeNull()
  })
})
