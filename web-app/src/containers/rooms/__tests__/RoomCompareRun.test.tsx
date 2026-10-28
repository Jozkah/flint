import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import {
  asJournal,
  createFakeApi,
  makeMessage,
  makeParticipant,
  makeRoom,
  renderWithApi,
} from './roomsTestUtils'
import { RoomControls } from '../RoomControls'
import { RoomTranscript } from '../RoomTranscript'
import { RoomEditor } from '../RoomEditor'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsT')
  return { useTranslation: () => ({ t: u.t }), i18n: { t: u.t } }
})
vi.mock('@/hooks/useModelProvider', async () => {
  const u = await import('./roomsTestUtils')
  return {
    useModelProvider: (sel: (s: { providers: unknown }) => unknown) => sel({ providers: u.testProviders }),
  }
})
vi.mock('@/containers/RenderMarkdown', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RenderMarkdown: ({ content }: any) => <div data-testid="render-markdown">{content}</div>,
}))

vi.mock('@/lib/rooms/unknownWindows', () => ({ ensureKnownWindows: async () => true }))
vi.mock('@/lib/modelReplace', () => ({ unavailableModels: () => [] }))

const bob = { kind: 'participant' as const, participantId: 'p2', name: 'Bob' }
const question = () => makeMessage({ id: 'q1', author: { kind: 'user' }, kind: 'user', text: 'Q1' })

describe('compare run panel', () => {
  it('runs one model, runs all, and offers the earlier questions to a model that missed them', async () => {
    const user = userEvent.setup()
    const journal = asJournal([
      question(),
      makeMessage({ text: 'Alice 1', compare: { provider: 'openai', model: 'tool-model', replyTo: 'q1' } }),
      makeMessage({ id: 'q2', author: { kind: 'user' }, kind: 'user', text: 'Q2' }),
    ])
    const fake = createFakeApi({ journal })
    const room = makeRoom({ mode: 'compare', status: 'awaiting-user', compareRun: 'one-by-one' })
    renderWithApi(<RoomControls room={room} />, fake.api)
    const panel = screen.getByTestId('compare-run-panel')
    expect(within(panel).getByTestId('compare-run-mode')).toHaveTextContent('One at a time')
    await user.click(within(panel).getByRole('button', { name: 'Run Alice again on the current question' }))
    await waitFor(() => expect(fake.controller.compareRun).toHaveBeenCalledWith('r1', ['p1'], 'latest'))
    await user.click(within(panel).getByRole('button', { name: 'Run all' }))
    await waitFor(() => expect(fake.controller.compareRun).toHaveBeenCalledWith('r1', null, 'latest'))
    // The app tooltip explains it; no native title bubble.
    expect(within(panel).getByTestId('compare-answer-earlier')).not.toHaveAttribute('title')
    await user.click(within(panel).getByTestId('compare-answer-earlier'))
    await waitFor(() => expect(fake.controller.compareRun).toHaveBeenCalledWith('r1', null, 'missing'))
  })

  it('switches a model off for the next run without removing it', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ journal: asJournal([question()]) })
    const room = makeRoom({ mode: 'compare', status: 'awaiting-user' })
    renderWithApi(<RoomControls room={room} />, fake.api)
    await user.click(screen.getByRole('checkbox', { name: 'Include Bob in the next run' }))
    expect(fake.api.updateRoomSettings).toHaveBeenCalledWith(
      room,
      expect.objectContaining({
        participants: [expect.objectContaining({ id: 'p2', compareSkip: true })],
      })
    )
  })

  it('shows each model state while a one-by-one run is going', () => {
    const fake = createFakeApi({
      journal: asJournal([question()]),
      liveTurns: [{ roomId: 'r1', turnId: 't1', author: { kind: 'participant', participantId: 'p1', name: 'Alice' }, text: '', startedAt: 1 }],
    })
    renderWithApi(<RoomControls room={makeRoom({ mode: 'compare', status: 'running' })} />, fake.api)
    const rows = screen.getAllByTestId('compare-participant')
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['running', 'queued'])
  })

  it('says a local model is waiting for the slot another local model holds', () => {
    const local = { provider: 'llamacpp', id: 'qwen' }
    const fake = createFakeApi({
      journal: asJournal([question()]),
      liveTurns: [{ roomId: 'r1', turnId: 't1', author: { kind: 'participant', participantId: 'p1', name: 'Alice' }, text: '', startedAt: 1 }],
    })
    const room = makeRoom({
      mode: 'compare',
      status: 'running',
      participants: [
        makeParticipant('p1', { name: 'Alice', model: local, order: 0 }),
        makeParticipant('p2', { name: 'Bob', model: { ...local, id: 'gemma' }, order: 1 }),
      ],
    })
    renderWithApi(<RoomControls room={room} />, fake.api)
    const rows = screen.getAllByTestId('compare-participant')
    expect(rows[1]).toHaveAttribute('data-state', 'waitingSlot')
    expect(rows[1]).toHaveTextContent('Queued: waiting for the local model slot')
  })

  it('names each model in full: aria-label and a tooltip, no native title', async () => {
    const user = userEvent.setup()
    const long = 'Qwen3 Coder 30B A3B Instruct the very long participant name'
    const fake = createFakeApi({ journal: asJournal([question()]) })
    const room = makeRoom({
      mode: 'compare',
      status: 'awaiting-user',
      participants: [
        makeParticipant('p1', { name: long, order: 0 }),
        makeParticipant('p2', { name: 'Bob', order: 1 }),
      ],
    })
    renderWithApi(<RoomControls room={room} />, fake.api)
    const name = screen.getAllByTestId('compare-participant-name')[0]
    expect(name).toHaveAttribute('aria-label', long)
    expect(name).not.toHaveAttribute('title')
    await user.hover(name)
    expect((await screen.findAllByRole('tooltip'))[0]).toHaveTextContent(long)
  })

  it('offers Retry with the reason on a model that failed to load', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ journal: asJournal([question()]) })
    const room = makeRoom({
      mode: 'compare',
      status: 'awaiting-user',
      participants: [
        makeParticipant('p1', { name: 'Alice', order: 0 }),
        makeParticipant('p2', {
          name: 'Bob',
          order: 1,
          availability: { state: 'unavailable', reason: 'load-failed', message: 'llama-server exited', at: 1 },
        }),
      ],
    })
    renderWithApi(<RoomControls room={room} />, fake.api)
    const bobRow = screen.getAllByTestId('compare-participant')[1]
    expect(bobRow).toHaveTextContent('llama-server exited')
    const retry = within(bobRow).getByRole('button', { name: 'Retry Bob' })
    expect(retry).toBeEnabled()
    await user.click(retry)
    await waitFor(() => expect(fake.controller.compareRun).toHaveBeenCalledWith('r1', ['p2'], 'latest'))
  })
})

describe('compare transcript', () => {
  it('renders a question and its answer row without duplicate React keys (T6-016)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fake = createFakeApi()
      const room = makeRoom({ mode: 'compare', status: 'awaiting-user' })
      const journal = asJournal([
        question(),
        makeMessage({ author: bob, text: 'Bob 1', compare: { provider: 'openai', model: 'm', replyTo: 'q1' } }),
        makeMessage({ id: 'q2', author: { kind: 'user' }, kind: 'user', text: 'Q2' }),
        makeMessage({ author: bob, text: 'Bob 2', compare: { provider: 'openai', model: 'm', replyTo: 'q2' } }),
      ])
      renderWithApi(<RoomTranscript room={room} journal={journal} liveTurn={null} />, fake.api)
      expect(screen.getAllByTestId('room-compare-row')).toHaveLength(2)
      const keyWarnings = errors.mock.calls.filter((c) => String(c[0]).includes('same key'))
      expect(keyWarnings).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('labels each answer with model and date, and leaves an empty cell to run', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi()
    const room = makeRoom({ mode: 'compare', status: 'awaiting-user' })
    const journal = asJournal([
      question(),
      makeMessage({ author: bob, text: 'Bob 1', createdAt: Date.UTC(2026, 0, 2), compare: { provider: 'openai', model: 'model-x', replyTo: 'q1', durationMs: 1500 } }),
      makeMessage({ author: bob, text: 'Bob rerun', createdAt: Date.UTC(2026, 5, 2), compare: { provider: 'openai', model: 'model-x', replyTo: 'q1' } }),
    ])
    renderWithApi(<RoomTranscript room={room} journal={journal} liveTurn={null} />, fake.api)
    const toggle = screen.getByTestId('room-link-scroll')
    expect(toggle).not.toHaveAttribute('title')
    // Hidden by container query once the columns stack.
    expect(toggle.className).toContain('@max-[520px]:hidden')
    const row = screen.getByTestId('room-compare-row')
    const labels = within(row).getAllByTestId('answer-meta')
    expect(labels).toHaveLength(2)
    // The model is named once, beside the participant, not again in the meta line.
    const cards = within(row).getAllByTestId('room-message')
    expect(cards[0].querySelector('header')!.textContent!.match(/model-x/g)).toHaveLength(1)
    expect(labels[0]).not.toHaveTextContent('model-x')
    expect(labels[0]).toHaveTextContent('1.5 s')
    expect(labels[0].textContent).not.toEqual(labels[1].textContent)
    const empty = within(row).getByTestId('compare-missing')
    expect(empty).toHaveTextContent('Alice')
    await user.click(within(empty).getByRole('button', { name: 'Run' }))
    expect(fake.controller.compareRun).toHaveBeenCalledWith('r1', ['p1'], 'latest')
  })

  it('an earlier question a model missed offers the earlier questions', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi()
    const room = makeRoom({ mode: 'compare', status: 'awaiting-user' })
    const journal = asJournal([
      question(),
      makeMessage({ author: bob, text: 'Bob 1' }),
      makeMessage({ id: 'q2', author: { kind: 'user' }, kind: 'user', text: 'Q2' }),
    ])
    renderWithApi(<RoomTranscript room={room} journal={journal} liveTurn={null} />, fake.api)
    const first = screen.getAllByTestId('room-compare-row')[0]
    await user.click(within(first).getByRole('button', { name: 'Answer the earlier questions' }))
    expect(fake.controller.compareRun).toHaveBeenCalledWith('r1', ['p1'], 'missing')
  })
})

describe('compare run in the editor', () => {
  it('explains the choice, suggests one at a time for two local models, and saves it', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    const room = makeRoom({
      mode: 'compare',
      participants: [
        makeParticipant('p1', { name: 'Alice', order: 0, model: { provider: 'llamacpp', id: 'a' } }),
        makeParticipant('p2', { name: 'Bob', order: 1, model: { provider: 'llamacpp', id: 'b' } }),
      ],
    })
    renderWithApi(<RoomEditor room={room} />, api)
    await user.click(screen.getByRole('radio', { name: 'Discussion' }))
    const setting = screen.getByTestId('compare-run-setting')
    expect(setting).toHaveTextContent('spares rate limits')
    expect(screen.getByTestId('compare-run-suggest')).toBeInTheDocument()
    await user.click(within(setting).getByRole('radio', { name: 'One at a time' }))
    expect(screen.queryByTestId('compare-run-suggest')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(api.updateRoomSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'compare', compareRun: 'one-by-one' })
    )
  })
})
