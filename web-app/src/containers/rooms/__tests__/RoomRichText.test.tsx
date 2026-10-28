import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { asJournal, makeMessage, makeRoom } from './roomsTestUtils'
import { RoomTranscript } from '../RoomTranscript'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsT')
  return { useTranslation: () => ({ t: u.t }), i18n: { t: u.t } }
})
vi.mock('@i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }), i18n: { t: u.t } }
})

const COPY = '[data-streamdown="code-block-copy-button"]'

// The real markdown renderer, as chat and Cowork use it.
describe('room messages as rich text', () => {
  it('renders a code fence as a code block with a copy button, and tables and lists', async () => {
    const msg = makeMessage({
      text: '## Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1\n```',
    })
    const { container } = render(
      <RoomTranscript room={makeRoom()} journal={asJournal([msg])} liveTurn={null} />
    )
    await waitFor(() => expect(container.querySelector(COPY)).not.toBeNull())
    expect(container.querySelector('h2')).toHaveTextContent('Plan')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('pre, [data-streamdown="code-block"]')).toHaveTextContent('const x = 1')
  })

  it('shows a tool call written as JSON text as a json code block with a note', async () => {
    const msg = makeMessage({
      text: JSON.stringify({ name: 'edit', arguments: { path: 'C:\\tmp\\app.js', content: 'x' } }),
    })
    const { container } = render(
      <RoomTranscript room={makeRoom()} journal={asJournal([msg])} liveTurn={null} />
    )
    await waitFor(() => expect(container.querySelector(COPY)).not.toBeNull())
    const note = screen.getByTestId('raw-tool-call-note')
    expect(note).toHaveTextContent('was not run')
    const block = container.querySelector('[data-streamdown="code-block"]') ?? container.querySelector('pre')
    expect(block).toHaveTextContent('"name": "edit"')
  })

  it('keeps ordinary text free of the note', () => {
    render(<RoomTranscript room={makeRoom()} journal={asJournal([makeMessage({ text: 'Hi {"a": 1}' })])} liveTurn={null} />)
    expect(screen.queryByTestId('raw-tool-call-note')).not.toBeInTheDocument()
  })

  it('keeps a compare column from widening: the answer body clips overflow to the column', () => {
    const room = makeRoom({ mode: 'compare' } as never)
    const msg = makeMessage({ text: '```\n' + 'x'.repeat(400) + '\n```' })
    render(<RoomTranscript room={room} journal={asJournal([msg])} liveTurn={null} />)
    const card = screen.getAllByTestId('room-message')[0]
    expect(within(card).getByTestId('room-message-text')).toHaveClass('min-w-0')
  })
})

describe('a turn that wrote no answer', () => {
  it('says the reply limit ran out and folds the thinking', () => {
    const msg = makeMessage({
      text: '',
      finishReason: 'length',
      reasoning: 'Let me think about mul...',
      usage: { inputTokens: 10, outputTokens: 1024, estimated: false },
    })
    render(<RoomTranscript room={makeRoom()} journal={asJournal([msg])} liveTurn={null} />)
    expect(screen.getByTestId('empty-reply')).toHaveTextContent('1024 tokens')
    expect(screen.getByTestId('empty-reply-thought')).toHaveTextContent('Let me think about mul...')
  })

  it('says a tool-only turn used tools', () => {
    const msg = makeMessage({ text: '', toolCalls: [{ name: 'read', ok: true, args: { path: 'a' } }] })
    render(<RoomTranscript room={makeRoom()} journal={asJournal([msg])} liveTurn={null} />)
    expect(screen.getByTestId('empty-reply')).toHaveTextContent(/used tools/i)
  })

  it('stays out of an answered turn', () => {
    render(<RoomTranscript room={makeRoom()} journal={asJournal([makeMessage({ text: 'Done.' })])} liveTurn={null} />)
    expect(screen.queryByTestId('empty-reply')).not.toBeInTheDocument()
  })
})
