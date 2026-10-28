import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { asJournal, createFakeApi, makeMessage, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomTranscript } from '../RoomTranscript'
import { RoomEditor } from '../RoomEditor'
import { RoomUsageBar } from '../RoomUsageBar'
import type { LiveTurn } from '@/lib/rooms/types'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsT')
  return { useTranslation: () => ({ t: u.t, i18n: { language: 'en' } }), i18n: { language: 'en', t: u.t } }
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

const bob = { kind: 'participant' as const, participantId: 'p2', name: 'Bob' }

describe('compare rooms in the transcript', () => {
  it('counts questions, not rounds, in the usage strip', () => {
    render(<RoomUsageBar room={makeRoom({ mode: 'compare' })} />)
    expect(screen.getByTestId('room-usage-details')).toHaveTextContent('Questions')
    expect(screen.getByTestId('room-usage-details')).not.toHaveTextContent('Rounds')
  })

  it("shows a round's answers side by side under the user's message, each with its figures", () => {
    const room = makeRoom({ mode: 'compare', status: 'awaiting-user' })
    const journal = asJournal([
      makeMessage({ author: { kind: 'user' }, kind: 'user', text: 'Explain wind chill' }),
      makeMessage({
        text: 'Alice answer',
        usage: { inputTokens: 10, outputTokens: 42, estimated: false, tokensPerSecond: 60 },
      }),
      makeMessage({ author: bob, text: 'Bob answer' }),
      makeMessage({ author: { kind: 'user' }, kind: 'user', text: 'Shorter' }),
      makeMessage({ author: bob, text: 'Bob again', round: 2 }),
    ])
    render(<RoomTranscript room={room} journal={journal} liveTurn={null} />)
    const rows = screen.getAllByTestId('room-compare-row')
    expect(rows).toHaveLength(2)
    const first = within(rows[0]).getAllByTestId('room-message')
    expect(first).toHaveLength(2)
    expect(first[0]).toHaveTextContent('Alice')
    expect(first[0]).toHaveTextContent('Alice answer')
    expect(within(first[0]).getByTestId('message-speed')).toHaveTextContent('42')
    expect(first[1]).toHaveTextContent('Bob answer')
    expect(rows[0]).toHaveAccessibleName('2 answers side by side')
    // Wrapping flex with a 240px basis: an odd answer left on the last line
    // grows to fill it, where an auto-fit grid left an empty cell beside it.
    expect(rows[0]).toHaveClass('flex', 'flex-wrap')
    expect(rows[0].className).not.toContain('grid')
    expect(first[0].className).toContain('flex-[1_1_min(100%,240px)]')
    // The user's messages stay full-width rows of their own.
    expect(screen.getByText('Shorter').closest('[data-testid="room-compare-row"]')).toBeNull()
  })

  it('streams every live answer in its own column, in participant order', () => {
    const room = makeRoom({ mode: 'compare', status: 'running' })
    const live = (turnId: string, author: LiveTurn['author'], text: string): LiveTurn => ({
      roomId: 'r1',
      turnId,
      author,
      text,
      startedAt: 1,
    })
    const turns = [
      live('t2', bob, 'Bob is writing'),
      live('t1', { kind: 'participant', participantId: 'p1', name: 'Alice' }, 'Alice is writing'),
    ]
    const journal = asJournal([makeMessage({ author: { kind: 'user' }, kind: 'user', text: 'Q' })])
    render(<RoomTranscript room={room} journal={journal} liveTurn={turns[1]} liveTurns={turns} />)
    const row = screen.getByTestId('room-compare-row')
    const cells = within(row).getAllByTestId('room-live-turn')
    expect(cells.map((c) => c.textContent)).toEqual([
      expect.stringContaining('Alice is writing'),
      expect.stringContaining('Bob is writing'),
    ])
  })

  it('leaves the other modes as a single column', () => {
    const room = makeRoom({ status: 'running' })
    const journal = asJournal([makeMessage({ text: 'a' }), makeMessage({ author: bob, text: 'b' })])
    render(<RoomTranscript room={room} journal={journal} liveTurn={null} />)
    expect(screen.queryByTestId('room-compare-row')).toBeNull()
    expect(screen.getAllByTestId('room-message')).toHaveLength(2)
  })
})

describe('compare in the room editor', () => {
  it('offers Compare models as a speaking mode and saves it', async () => {
    const user = userEvent.setup()
    const { api } = createFakeApi()
    renderWithApi(<RoomEditor room={makeRoom()} />, api)
    await user.click(screen.getByRole('radio', { name: 'Discussion' }))
    const group = screen.getByRole('radiogroup', { name: 'Speaking mode' })
    const compare = within(group).getByRole('radio', { name: 'Compare models' })
    expect(compare).toHaveAccessibleDescription(/answer on their own/)
    await user.click(compare)
    expect(compare).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(api.updateRoomSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'compare' })
    )
  })
})
