import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { RoomStatus } from '@/lib/rooms/types'
import { createFakeApi, makeParticipant, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomControls } from '../RoomControls'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})

const btn = (name: string) => screen.getByRole('button', { name })

const live = { roomId: 'r1', turnId: 't1', author: { kind: 'system' as const }, text: '', startedAt: 1 }

function setup(status: RoomStatus, opts: { live?: boolean } = {}) {
  const fake = createFakeApi({ liveTurn: opts.live ? live : null })
  renderWithApi(<RoomControls room={makeRoom({ status })} />, fake.api)
  return fake
}

describe('RoomControls', () => {
  it('draft: only Start is enabled and it starts the room', async () => {
    const { controller } = setup('draft')
    expect(btn('Start')).toBeEnabled()
    // One main button: a room that is not running offers Start, not Pause.
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    for (const name of ['Cancel turn', 'Stop', 'Next speaker', 'Call vote', 'Final positions', 'Synthesize'])
      expect(btn(name)).toBeDisabled()
    await userEvent.click(btn('Start'))
    expect(controller.start).toHaveBeenCalledWith('r1')
  })

  it('draft with fewer than two participants cannot start', () => {
    const fake = createFakeApi()
    renderWithApi(
      <RoomControls room={makeRoom({ participants: [makeParticipant('p1', { name: 'Solo' })] })} />,
      fake.api
    )
    expect(btn('Start')).toBeDisabled()
    expect(screen.getByText('Add at least two participants to start.')).toBeInTheDocument()
  })

  it('running mid-turn: pause, cancel turn and stop; no between-turn actions', async () => {
    const { controller } = setup('running', { live: true })
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(btn('Pause')).toBeEnabled()
    expect(btn('Cancel turn')).toBeEnabled()
    expect(btn('Stop')).toBeEnabled()
    for (const name of ['Next speaker', 'Call vote', 'Final positions', 'Synthesize']) expect(btn(name)).toBeDisabled()
    await userEvent.click(btn('Cancel turn'))
    expect(controller.cancelTurn).toHaveBeenCalledWith('r1')
    await userEvent.click(btn('Pause'))
    expect(controller.pause).toHaveBeenCalledWith('r1')
  })

  it('paused: resume, vote, final positions and synthesize call the controller', async () => {
    const user = userEvent.setup()
    const { controller } = setup('paused')
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(btn('Cancel turn')).toBeDisabled()

    await user.click(btn('Resume'))
    expect(controller.resume).toHaveBeenCalledWith('r1')

    await user.click(btn('Call vote'))
    expect(btn('Ask for votes')).toBeDisabled()
    await user.type(screen.getByLabelText('Proposal'), 'Adopt plan X')
    await user.click(btn('Ask for votes'))
    expect(controller.callVote).toHaveBeenCalledWith('r1', 'Adopt plan X')

    await user.click(btn('Final positions'))
    expect(controller.requestFinalPositions).toHaveBeenCalledWith('r1')
    await user.click(btn('Synthesize'))
    expect(controller.synthesize).toHaveBeenCalledWith('r1')
  })

  it('completed: a room that finished on its own can still be wrapped up', async () => {
    const user = userEvent.setup()
    const { controller } = setup('completed')
    for (const name of ['Call vote', 'Final positions', 'Synthesize']) expect(btn(name)).toBeEnabled()
    expect(btn('Cancel turn')).toBeDisabled()
    await user.click(btn('Final positions'))
    expect(controller.requestFinalPositions).toHaveBeenCalledWith('r1')
    await user.click(btn('Synthesize'))
    expect(controller.synthesize).toHaveBeenCalledWith('r1')
  })

  it('stop asks for confirmation first', async () => {
    const user = userEvent.setup()
    const { controller } = setup('running')
    await user.click(btn('Stop'))
    expect(screen.getByRole('dialog', { name: 'Stop the discussion?' })).toBeInTheDocument()
    expect(controller.stop).not.toHaveBeenCalled()
    await user.click(btn('Stop room'))
    expect(controller.stop).toHaveBeenCalledWith('r1')
  })

  it('selects the next speaker from a menu of available participants', async () => {
    const fake = createFakeApi()
    const room = makeRoom({
      status: 'awaiting-user',
      participants: [
        makeParticipant('p1', { name: 'Alice' }),
        makeParticipant('p2', { name: 'Bob', role: 'expert', order: 1 }),
        makeParticipant('p3', {
          name: 'Down',
          order: 2,
          availability: { state: 'unavailable', reason: 'load-failed', message: '', at: 1 },
        }),
      ],
    })
    renderWithApi(<RoomControls room={room} />, fake.api)
    const trigger = btn('Next speaker')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const item = await screen.findByRole('menuitem', { name: 'Bob · expert' })
    expect(screen.queryByRole('menuitem', { name: /Down/ })).not.toBeInTheDocument()
    fireEvent.click(item)
    await waitFor(() => expect(fake.controller.selectNext).toHaveBeenCalledWith('r1', 'p2'))
  })

  it('picks the next speaker straight from the up-next queue', async () => {
    const fake = createFakeApi()
    const room = makeRoom({
      status: 'awaiting-user',
      participants: [
        makeParticipant('p1', { name: 'Alice' }),
        makeParticipant('p2', { name: 'Bob', order: 1 }),
      ],
    })
    renderWithApi(<RoomControls room={room} />, fake.api)
    expect(screen.getByText('Up next')).toBeInTheDocument()
    await userEvent.click(btn('Let Bob speak next'))
    expect(fake.controller.selectNext).toHaveBeenCalledWith('r1', 'p2')
  })

  it('names who is speaking during a live turn', () => {
    const fake = createFakeApi({
      liveTurn: {
        ...live,
        author: { kind: 'participant', participantId: 'p1', name: 'Alice' },
      },
    })
    renderWithApi(<RoomControls room={makeRoom({ status: 'running' })} />, fake.api)
    expect(screen.getByText('Alice is speaking')).toBeInTheDocument()
  })

  it('shows busy state and engine errors', () => {
    const fake = createFakeApi({ pendingAction: 'start', lastError: { message: 'Provider exploded' } })
    renderWithApi(<RoomControls room={makeRoom({ status: 'paused' })} />, fake.api)
    expect(btn('Resume')).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    expect(screen.getByRole('alert')).toHaveTextContent('Provider exploded')
    act(() => fake.set({ pendingAction: null, lastError: null }))
    expect(btn('Resume')).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a rejected controller call as an error', async () => {
    const fake = createFakeApi()
    fake.controller.start.mockRejectedValueOnce({ code: 'io', message: 'Disk full' })
    renderWithApi(<RoomControls room={makeRoom()} />, fake.api)
    await userEvent.click(btn('Start'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full')
  })
})
