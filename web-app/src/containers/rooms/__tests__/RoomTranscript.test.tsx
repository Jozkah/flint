import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { asJournal, makeMessage, makeRoom } from './roomsTestUtils'
import { RoomTranscript } from '../RoomTranscript'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})

// The markdown renderer is defer-rendered and covered by its own tests; here we
// only care that the transcript delegates to it and never emits raw HTML. The
// stub renders the (already mention-linkified) content as text.
vi.mock('@/containers/RenderMarkdown', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RenderMarkdown: ({ content }: any) => <div data-testid="render-markdown">{content}</div>,
}))

const byKind = (kind: string) =>
  screen.getAllByTestId('room-message').filter((el) => el.getAttribute('data-kind') === kind)

describe('RoomTranscript', () => {
  it('renders every message kind with attribution, addressing and badges', () => {
    const room = makeRoom({ moderator: { enabled: true, name: 'Mod', model: null } })
    const call = makeMessage({
      author: { kind: 'moderator', name: 'Mod' },
      kind: 'vote-call',
      text: 'Adopt plan X',
    })
    const messages = [
      makeMessage({ text: 'Opening', to: { kind: 'participant', participantId: 'p2' } }),
      makeMessage({
        author: { kind: 'moderator', name: 'Mod' },
        kind: 'moderator-note',
        text: 'Two camps',
        directive: { next: 'Bob', request: null, disagreements: ['Scope of X'], converged: false, stop: false, reason: '' },
      }),
      makeMessage({ author: { kind: 'user' }, kind: 'user', text: 'Please focus', to: { kind: 'moderator' } }),
      makeMessage({ author: { kind: 'system' }, kind: 'system', text: 'Bob is unavailable' }),
      call,
      makeMessage({ kind: 'vote', text: 'Yes', vote: { callId: call.id, choice: 'agree', proposal: 'Adopt plan X' } }),
      makeMessage({
        author: { kind: 'participant', participantId: 'p2', name: 'Bob' },
        kind: 'vote',
        text: 'No',
        vote: { callId: call.id, choice: 'disagree', proposal: 'Adopt plan X' },
      }),
      makeMessage({ kind: 'final-position', text: 'X is fine' }),
      makeMessage({
        author: { kind: 'moderator', name: 'Mod' },
        kind: 'synthesis',
        text: 'We adopt X.',
        dissent: [{ participantId: 'p2', name: 'Bob', position: 'X is too risky' }],
      }),
      makeMessage({ kind: 'speech', text: 'Half a thou', status: 'interrupted' }),
      makeMessage({
        author: { kind: 'participant', participantId: 'p2', name: 'Bob' },
        kind: 'error',
        text: '',
        status: 'failed',
        error: { code: 'rate_limited', message: 'Rate limit hit' },
      }),
    ]
    render(<RoomTranscript room={room} journal={asJournal(messages)} liveTurn={null} />)

    const [speech, interrupted] = byKind('speech')
    expect(within(speech).getByText('Alice · skeptic · tool-model')).toBeInTheDocument()
    expect(within(speech).getByText('to @Bob')).toBeInTheDocument()
    expect(within(interrupted).getByText('Interrupted')).toBeInTheDocument()

    const note = byKind('moderator-note')[0]
    expect(within(note).getByText('Mod · Moderator')).toBeInTheDocument()
    expect(within(note).getByText('Scope of X')).toBeInTheDocument()

    const user = byKind('user')[0]
    expect(within(user).getByText('You')).toBeInTheDocument()
    expect(within(user).getByText('to @moderator')).toBeInTheDocument()

    expect(byKind('system')[0]).toHaveTextContent('Bob is unavailable')

    const voteCall = byKind('vote-call')[0]
    expect(within(voteCall).getByTestId('vote-tally')).toHaveTextContent('Agree 1 · Disagree 1 · Abstain 0')
    expect(screen.getByText('Vote: Agree')).toBeInTheDocument()
    expect(screen.getByText('Vote: Disagree')).toBeInTheDocument()

    expect(within(byKind('final-position')[0]).getByText('Final position')).toBeInTheDocument()

    const synthesis = byKind('synthesis')[0]
    const dissent = within(synthesis).getByRole('region', { name: 'Dissent' })
    expect(dissent).toHaveTextContent('Bob')
    expect(dissent).toHaveTextContent('X is too risky')
    expect(within(synthesis).getByText('We adopt X.')).toBeInTheDocument()

    const error = byKind('error')[0]
    expect(error).toHaveAttribute('data-status', 'failed')
    expect(within(error).getByText('Failed')).toBeInTheDocument()
    expect(within(error).getByTestId('message-error')).toHaveTextContent('Rate limit hit')
  })

  it('renders message text through the markdown renderer, never as raw HTML or scripts', () => {
    const text = '<script>window.__pwned = true</script>\n**bold** <img src=x onerror=alert(1)>'
    const { container } = render(
      <RoomTranscript room={makeRoom()} journal={asJournal([makeMessage({ text })])} liveTurn={null} />
    )
    // Delegated to the shared markdown renderer (so **bold** etc. format), which
    // has its own rendering + sanitization tests.
    expect(screen.getAllByTestId('render-markdown').length).toBeGreaterThan(0)
    // Raw HTML and scripts never become live elements or execute.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('highlights messages addressed to the user', () => {
    render(
      <RoomTranscript
        room={makeRoom()}
        journal={asJournal([makeMessage({ text: 'What do you think?', to: { kind: 'user' } })])}
        liveTurn={null}
      />
    )
    const msg = screen.getByTestId('room-message')
    expect(msg).toHaveAttribute('data-addressed-to-user', 'true')
    expect(within(msg).getByText('Addressed to you')).toBeInTheDocument()
    expect(within(msg).getByText('to you')).toBeInTheDocument()
  })

  it('uses a polite log for complete messages and streams the live turn outside it', () => {
    render(
      <RoomTranscript
        room={makeRoom()}
        journal={asJournal([makeMessage({ text: 'done' })])}
        liveTurn={{
          roomId: 'r1',
          turnId: 't9',
          author: { kind: 'participant', participantId: 'p2', name: 'Bob' },
          text: 'partial <b>reply</b>',
          startedAt: 1,
        }}
      />
    )
    const log = screen.getByRole('log', { name: 'Discussion transcript' })
    expect(log).toHaveAttribute('aria-live', 'polite')
    const liveTurn = screen.getByTestId('room-live-turn')
    expect(log).not.toContainElement(liveTurn)
    expect(liveTurn).toHaveTextContent('Bob · expert · tool-model')
    // The live turn renders as markdown too; raw HTML is never emitted.
    expect(liveTurn).toHaveTextContent('partial')
    expect(liveTurn).toHaveTextContent('reply')
    expect(liveTurn.querySelector('b')).toBeNull()
  })

  it('shows an empty state', () => {
    render(<RoomTranscript room={makeRoom()} journal={[]} liveTurn={null} />)
    expect(screen.getByText('Nothing has been said yet.')).toBeInTheDocument()
  })
})
