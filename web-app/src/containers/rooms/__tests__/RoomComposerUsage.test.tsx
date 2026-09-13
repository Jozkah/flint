import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { createFakeApi, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomComposer } from '../RoomComposer'
import { RoomUsageBar } from '../RoomUsageBar'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})

describe('RoomComposer', () => {
  it('sends to the room by default and clears the text', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    const box = screen.getByLabelText('Message to the room')
    await user.type(box, 'Hello all')
    await user.click(send)
    expect(controller.sendUserMessage).toHaveBeenCalledWith('r1', 'Hello all', { kind: 'room' })
    expect(box).toHaveValue('')
  })

  it('addresses a participant or the moderator', async () => {
    const user = userEvent.setup()
    const { api, controller } = createFakeApi()
    renderWithApi(
      <RoomComposer room={makeRoom({ moderator: { enabled: true, name: 'Chair', model: null } })} />,
      api
    )
    const to = screen.getByLabelText('Send to')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Everyone', 'Chair', 'Alice', 'Bob'])

    await user.selectOptions(to, 'Bob')
    await user.type(screen.getByLabelText('Message to the room'), 'Your view?')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(controller.sendUserMessage).toHaveBeenLastCalledWith('r1', 'Your view?', {
      kind: 'participant',
      participantId: 'p2',
    })

    await user.selectOptions(to, 'Chair')
    await user.type(screen.getByLabelText('Message to the room'), 'Wrap up')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(controller.sendUserMessage).toHaveBeenLastCalledWith('r1', 'Wrap up', { kind: 'moderator' })
  })

  it('omits the moderator when disabled', () => {
    const { api } = createFakeApi()
    renderWithApi(<RoomComposer room={makeRoom()} />, api)
    expect(screen.queryByRole('option', { name: 'Mod' })).not.toBeInTheDocument()
  })
})

describe('RoomUsageBar', () => {
  it('shows usage against limits with an estimated marker and no invented cost', () => {
    const room = makeRoom({
      status: 'stopped',
      usage: {
        turns: 3,
        rounds: 1,
        inputTokens: 1000,
        outputTokens: 234,
        estimated: true,
        costUsd: null,
        activeMs: 65_000,
        consecutiveRepetitive: 0,
      },
      stopReason: { kind: 'limit', limit: 'maxTurns' },
    })
    render(<RoomUsageBar room={room} />)
    const bar = screen.getByRole('region', { name: 'Usage' })
    expect(bar).toHaveTextContent('Turns3 / 40')
    expect(bar).toHaveTextContent('1,234 / 200,000(estimated)')
    expect(bar).toHaveTextContent('not available without pricing')
    expect(bar).toHaveTextContent('1:05 / 30:00')
    expect(screen.getByTestId('room-stop-reason')).toHaveTextContent('Stopped: limit reached (Turns)')
  })

  it('shows cost when computable', () => {
    const room = makeRoom({
      limits: { ...makeRoom().limits, maxCostUsd: 2 },
      usage: { ...makeRoom().usage, costUsd: 0.5 },
    })
    render(<RoomUsageBar room={room} />)
    expect(screen.getByRole('region', { name: 'Usage' })).toHaveTextContent('$0.50 / $2.00')
    expect(screen.queryByTestId('room-stop-reason')).not.toBeInTheDocument()
  })
})
