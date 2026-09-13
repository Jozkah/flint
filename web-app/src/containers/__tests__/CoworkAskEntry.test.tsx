import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { CoworkAskEntry } from '@/containers/CoworkAskEntry'
import type { AskRecord } from '@/types/coworkSession'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'count' in vars ? `${vars.count} selected` : key,
  }),
}))

const record = (over: Partial<AskRecord> = {}): AskRecord => ({
  requestId: 'call-1',
  sessionId: 's1',
  callId: 'call-1',
  at: '2026-09-08T10:00:00Z',
  state: 'pending',
  request: {
    questions: [
      {
        id: 'scope',
        question: 'Which scope?',
        options: [{ label: 'Small' }, { label: 'Large' }],
      },
    ],
  },
  ...over,
})

describe('CoworkAskEntry', () => {
  it('shows the card while the run is waiting for an answer', () => {
    render(
      <CoworkAskEntry record={record()} running onRespond={vi.fn()} />
    )
    expect(screen.getByTestId('cowork-ask-card')).toBeInTheDocument()
    expect(screen.getByTestId('ask-entry')).toHaveAttribute(
      'data-state',
      'pending'
    )
  })

  it('collapses to the chosen answer once answered, and stays in the transcript', () => {
    render(
      <CoworkAskEntry
        record={record({
          state: 'answered',
          answers: [{ id: 'scope', selected: ['Small'] }],
        })}
        running
        onRespond={vi.fn()}
      />
    )
    expect(screen.queryByTestId('cowork-ask-card')).toBeNull()
    expect(screen.getByText('Which scope?')).toBeInTheDocument()
    expect(screen.getByTestId('ask-entry-answer')).toHaveTextContent('Small')
  })

  it('shows the text that was typed for a custom answer', () => {
    render(
      <CoworkAskEntry
        record={record({
          state: 'answered',
          answers: [{ id: 'scope', selected: [], custom_input: 'squash it' }],
        })}
        running
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('ask-entry-answer')).toHaveTextContent('squash it')
  })

  it('leaves a visible cancelled state rather than vanishing', () => {
    render(
      <CoworkAskEntry
        record={record({ state: 'cancelled' })}
        running={false}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByTestId('ask-entry')).toHaveAttribute(
      'data-state',
      'cancelled'
    )
    expect(screen.getByTestId('ask-entry-answer')).toHaveTextContent(
      'common:askSkipped'
    )
  })

  it('marks a question stale when the run that asked it is gone', () => {
    // Restored from disk after a restart: it says pending, but nothing is
    // waiting for the answer any more.
    render(
      <CoworkAskEntry record={record()} running={false} onRespond={vi.fn()} />
    )
    expect(screen.getByTestId('ask-entry')).toHaveAttribute('data-state', 'stale')
    expect(screen.queryByTestId('cowork-ask-card')).toBeNull()
  })

  it('will not take an answer for a stale question', () => {
    const onRespond = vi.fn()
    render(
      <CoworkAskEntry record={record()} running={false} onRespond={onRespond} />
    )
    // There is no control to press: the card is not rendered at all.
    expect(screen.queryByLabelText('common:submit')).toBeNull()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('answers through the callback with the request it belongs to', () => {
    const onRespond = vi.fn()
    render(
      <CoworkAskEntry
        record={record({ requestId: 'call-7' })}
        running
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('Small'))
    fireEvent.click(screen.getByLabelText('common:submit'))
    expect(onRespond).toHaveBeenCalledWith('call-7', [
      { id: 'scope', selected: ['Small'] },
    ])
  })
})
