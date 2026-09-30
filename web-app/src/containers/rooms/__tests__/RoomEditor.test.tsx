import { describe, it, expect, vi } from 'vitest'
import { screen, within, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { createFakeApi, makeParticipant, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomEditor } from '../RoomEditor'
import { RoomsApiProvider } from '../roomsBindings'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})
vi.mock('@/hooks/useModelProvider', async () => {
  const u = await import('./roomsTestUtils')
  return {
    useModelProvider: (sel: (s: { providers: unknown }) => unknown) => sel({ providers: u.testProviders }),
  }
})

const participantCard = (name: string) =>
  screen.getAllByTestId('room-participant').find((el) =>
    within(el).queryByDisplayValue(name)
  )!

describe('RoomEditor', () => {
  it('rejects duplicate participant names case-insensitively on save', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)

    const bob = participantCard('Bob')
    const name = within(bob).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'alice')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(screen.getAllByText('Another participant is already called “alice”.').length).toBeGreaterThan(0)
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(api.updateRoomSettings).not.toHaveBeenCalled()
  })

  it('validates and adds a new participant', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)

    // The add form folds behind the Participants header's Add button.
    const toggle = screen.getByRole('button', { name: 'Add' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const nameInputs = screen.getAllByLabelText('Name')
    const newName = nameInputs[nameInputs.length - 1]
    await user.type(newName, 'ALICE')
    const modelSelects = screen.getAllByLabelText('Model')
    await user.click(modelSelects[modelSelects.length - 1])
    await user.click((await screen.findAllByRole('menuitemradio', { name: /^Plain Model/ })).at(-1)!)
    await user.click(screen.getByRole('button', { name: 'Add participant' }))
    expect(screen.getByText('Another participant is already called “ALICE”.')).toBeInTheDocument()
    expect(api.addParticipant).not.toHaveBeenCalled()

    await user.clear(newName)
    await user.type(newName, 'Carol')
    await user.click(screen.getByRole('button', { name: 'Add participant' }))
    // toolAccess is omitted so the controller applies its default (read-only
    // for a tool-capable model) rather than starting the participant tool-less.
    expect(api.addParticipant).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), {
      name: 'Carol',
      role: '',
      model: { provider: 'openai', id: 'plain-model' },
    })
  })

  it('disables tool access for a model without the tools capability and explains why', () => {
    const { api } = createFakeApi()
    const room = makeRoom({
      participants: [
        makeParticipant('p1', { name: 'Alice', model: { provider: 'openai', id: 'tool-model' } }),
        makeParticipant('p2', {
          name: 'Bob',
          order: 1,
          toolAccess: 'read',
          model: { provider: 'openai', id: 'plain-model' },
        }),
      ],
    })
    renderWithApi(<RoomEditor room={room} />, api)

    const bob = participantCard('Bob')
    const bobRadios = within(within(bob).getByRole('radiogroup', { name: 'Tool access' })).getAllByRole('radio')
    bobRadios.forEach((r) => expect(r).toBeDisabled())
    expect(within(bob).getByRole('radio', { name: 'None' })).toBeChecked()
    expect(within(bob).getByText('This model does not support tools, so tool access stays off.')).toBeInTheDocument()

    const alice = participantCard('Alice')
    expect(within(alice).getByRole('radio', { name: 'Read-only' })).toBeEnabled()
    expect(within(alice).getByText(/Approvals never apply in rooms/)).toBeInTheDocument()
  })

  it("saves a participant's Reasoning and Reasoning effort, and leaves the others at the default", async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)

    const alice = participantCard('Alice')
    const reasoning = within(alice).getByRole('radiogroup', { name: 'Reasoning' })
    expect(within(reasoning).getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(reasoning).getByRole('radio', { name: 'On' }))
    const effort = within(alice).getByRole('radiogroup', { name: 'Reasoning effort' })
    expect(within(effort).getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(effort).getByRole('radio', { name: 'High' }))
    // OpenAI takes no token budget: that control is llama.cpp's alone.
    expect(within(alice).queryByRole('radiogroup', { name: 'Thinking Budget' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    const patch = api.updateRoomSettings.mock.calls[0][1]
    expect(patch.participants[0].reasoning).toEqual({ mode: 'on', level: 'high' })
    expect(patch.participants[1].reasoning).toBeNull()
  })

  it('offers a Thinking Budget, defaulting to Unlimited, for a llama.cpp participant', () => {
    const { api } = createFakeApi()
    const room = makeRoom({
      participants: [
        makeParticipant('p1', { name: 'Alice', model: { provider: 'llamacpp', id: 'qwen' } }),
      ],
    })
    renderWithApi(<RoomEditor room={room} />, api)
    const budget = within(participantCard('Alice')).getByRole('radiogroup', { name: 'Thinking Budget' })
    expect(
      ['Low', 'Medium', 'High', 'XHigh', 'Unlimited'].map((n) => within(budget).getByRole('radio', { name: n }))
    ).toHaveLength(5)
    expect(within(budget).getByRole('radio', { name: 'Unlimited' })).toHaveAttribute('aria-checked', 'true')
    expect(within(participantCard('Alice')).queryByRole('radiogroup', { name: 'Reasoning effort' })).toBeNull()
  })

  it('flags a limit below its minimum and saves the raised value (#175)', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)

    const rounds = screen.getByLabelText('Rounds') as HTMLInputElement
    await user.clear(rounds)
    await user.type(rounds, '-3')
    expect(screen.getByText('Raised to the minimum of 1.')).toBeInTheDocument()
    fireEvent.blur(rounds)
    expect(rounds.value).toBe('1')

    const minutes = screen.getByLabelText('Running time (minutes)') as HTMLInputElement
    await user.clear(minutes)
    await user.type(minutes, '0')
    // The minimum is shown in minutes, the input's unit, not milliseconds.
    expect(screen.getByText('Raised to the minimum of 1.')).toBeInTheDocument()
    fireEvent.blur(minutes)
    expect(minutes.value).toBe('1')

    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    const patch = api.updateRoomSettings.mock.calls[0][1]
    expect(patch.limits.maxRounds).toBe(1)
    expect(patch.limits.maxDurationMs).toBe(60_000)
  })

  it('shows ceilings, caps limits above them and saves the clamped value', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)

    const rounds = screen.getByLabelText('Rounds') as HTMLInputElement
    expect(screen.getAllByText('Max 50').length).toBeGreaterThan(0)
    await user.clear(rounds)
    await user.type(rounds, '999')
    expect(screen.getByText('Capped at 50.')).toBeInTheDocument()
    fireEvent.blur(rounds)
    expect(rounds.value).toBe('50')

    const minutes = screen.getByLabelText('Running time (minutes)') as HTMLInputElement
    expect(screen.getByText('Max 240')).toBeInTheDocument()
    await user.clear(minutes)
    await user.type(minutes, '1000')
    expect(screen.getByText('Capped at 240.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(api.updateRoomSettings).toHaveBeenCalledTimes(1)
    const patch = api.updateRoomSettings.mock.calls[0][1]
    expect(patch.limits.maxRounds).toBe(50)
    expect(patch.limits.maxDurationMs).toBe(240 * 60_000)
    expect(patch.limits.maxCostUsd).toBeNull()
  })

  it('explains that the cost limit needs pricing for every model', () => {
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)
    expect(screen.getByText(/works only when every model that speaks has pricing/)).toBeInTheDocument()
    expect(screen.getByTestId('cost-missing-pricing')).toBeInTheDocument()
  })

  it('is disabled while the room is running', () => {
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom({ status: 'running' })} />, api)
    expect(screen.getByText('Pause the room to change settings.')).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toBeDisabled()
    // Locked: the save button gives way to a Pause shortcut.
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    // The settings tabs stay usable so the locked values can still be read.
    screen
      .getAllByRole('radio')
      .filter((r) => !r.closest('[data-slot="segmented"]'))
      .forEach((r) => expect(r).toBeDisabled())
  })

  it('shows participant availability problems', () => {
    const { api } = createFakeApi()
    const room = makeRoom({
      participants: [
        makeParticipant('p1', {
          name: 'Alice',
          availability: { state: 'unavailable', reason: 'provider-not-configured', message: 'No API key', at: 1 },
        }),
        makeParticipant('p2', {
          name: 'Bob',
          order: 1,
          model: { provider: 'gone', id: 'ghost' },
          availability: { state: 'unavailable', reason: 'model-missing', message: '', at: 1 },
        }),
      ],
    })
    renderWithApi(<RoomEditor room={room} />, api)
    expect(screen.getByText('Provider is not configured — No API key')).toBeInTheDocument()
    expect(screen.getByText('Model is missing')).toBeInTheDocument()
    // A model that no longer resolves stays visible as the current choice.
    expect(screen.getByText('gone / ghost (missing)')).toBeInTheDocument()
  })

  // #165: while the form was dirty, a new revision updated the participant
  // list but not each kept participant's availability.
  it('refreshes participant availability from a new revision while editing', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    const room = makeRoom()
    const { rerender } = renderWithApi(<RoomEditor room={room} />, api)
    await user.type(screen.getByLabelText('Title'), ' edited')

    const next = makeRoom({
      rev: room.rev + 1,
      participants: room.participants.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              availability: { state: 'unavailable' as const, reason: 'provider-not-configured' as const, message: 'No API key', at: 2 },
            }
          : p
      ),
    })
    rerender(
      <RoomsApiProvider api={api}>
        <RoomEditor room={next} />
      </RoomsApiProvider>
    )

    expect(screen.getByText('Provider is not configured — No API key')).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveValue('Alpha edited')
  })

  it('requires a moderator for moderator-chosen mode', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom({ mode: 'moderator-selected' })} />, api)
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    // Saving jumps to the tab that holds the problem.
    expect(screen.getByRole('radio', { name: 'Discussion' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Moderator-chosen mode needs an enabled moderator.')).toBeInTheDocument()
    expect(api.updateRoomSettings).not.toHaveBeenCalled()
  })

  it('exposes the speaking mode as a keyboard-operable radiogroup', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)
    await user.click(screen.getByRole('radio', { name: 'Discussion' }))
    const group = screen.getByRole('radiogroup', { name: 'Speaking mode' })
    const rr = within(group).getByRole('radio', { name: 'Round-robin' })
    expect(rr).toBeChecked()
    rr.focus()
    await user.keyboard('{ArrowDown}')
    const next = within(group).getByRole('radio', { name: 'You choose' })
    // Radix moves focus on arrow keys (roving tabindex); Space selects.
    await waitFor(() => expect(next).toHaveFocus())
    await user.keyboard(' ')
    expect(next).toBeChecked()
    expect(rr).not.toBeChecked()
  })

  it('removes a participant through the api', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)
    await user.click(screen.getByRole('button', { name: 'Remove Bob' }))
    expect(api.removeParticipant).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 'p2')
  })

  it('shows the two-participant hint only below two participants', () => {
    const { api } = createFakeApi()
    const hint = /At least two participants are needed/
    const { unmount } = renderWithApi(<RoomEditor room={makeRoom()} />, api)
    expect(screen.queryByText(hint)).not.toBeInTheDocument()
    unmount()
    renderWithApi(
      <RoomEditor room={makeRoom({ participants: [makeParticipant('p1', { name: 'Solo' })] })} />,
      api
    )
    expect(screen.getByText(hint)).toBeInTheDocument()
  })

  it('gives every settings control its own accessible name', () => {
    const { api } = createFakeApi()
    const { container } = renderWithApi(<RoomEditor room={makeRoom()} />, api)
    // Radix radios and switches are bare <button>s; each carries its own name
    // rather than relying on a label elsewhere in the DOM.
    const bare = [...container.querySelectorAll('button')].filter((b) => !b.textContent?.trim())
    expect(bare.length).toBeGreaterThan(0)
    for (const el of bare) expect(el).toHaveAttribute('aria-label')
    expect(container.querySelector('button[role="switch"]')).toHaveAttribute('aria-label', 'Use a moderator')
  })
})
