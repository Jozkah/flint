import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CoworkAskedCard } from '../CoworkAskedCard'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'

const session = (id: string): CoworkSession =>
  ({ id, title: id, folder: null, turns: [], messages: [], updated: 0 }) as CoworkSession

describe('CoworkAskedCard', () => {
  beforeEach(() => {
    useCoworkSessions.setState({ sessions: [session('A'), session('S2')], currentId: 'A' })
  })

  it('shows the answer as plain text and opens the other session', () => {
    render(
      <CoworkAskedCard
        asked={{
          key: 'c1',
          name: 'Beta',
          sessionId: 'S2',
          status: 'answered',
          answer: '<b>forty-two</b>',
        }}
      />
    )
    expect(screen.getByTestId('agent-asked-answer').textContent).toBe(
      '<b>forty-two</b>'
    )
    fireEvent.click(screen.getByTestId('agent-asked-open'))
    expect(useCoworkSessions.getState().currentId).toBe('S2')
  })

  it('has no link for a session that is gone and no answer block without one', () => {
    render(
      <CoworkAskedCard
        asked={{
          key: 'c2',
          name: 'Ghost',
          sessionId: 'gone',
          status: 'waiting',
          answer: null,
        }}
      />
    )
    expect(screen.queryByTestId('agent-asked-open')).toBeNull()
    expect(screen.queryByTestId('agent-asked-answer')).toBeNull()
    expect(screen.getByTestId('agent-asked-status')).toBeTruthy()
  })

  it('says why a send was refused, in plain words', () => {
    render(
      <CoworkAskedCard
        asked={{
          key: 'c3',
          name: 'Beta',
          sessionId: null,
          status: 'notSent',
          answer: null,
          reason: 'chain_limit_reached',
        }}
      />
    )
    const status = screen.getByTestId('agent-asked-status')
    expect(status.textContent).toBe('messaging:asked.notSentReason')
    expect(status.getAttribute('data-reason')).toBe('chain_limit_reached')
  })

  it('falls back to the plain "Not sent" for an unknown reason', () => {
    render(
      <CoworkAskedCard
        asked={{
          key: 'c4',
          name: 'Beta',
          sessionId: null,
          status: 'notSent',
          answer: null,
          reason: null,
        }}
      />
    )
    expect(screen.getByTestId('agent-asked-status').textContent).toBe(
      'messaging:asked.notSent'
    )
  })
})
