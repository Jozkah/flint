/**
 * The overlap question, shown before any team child runs. AH-109.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CoworkTeamConflicts } from '../CoworkTeamConflicts'
import {
  useTeamConflictRequests,
  type ConflictAnswer,
} from '@/hooks/useTeamConflictRequests'
import { conflictKey, scopeConflicts, type TeamTask } from '@/lib/coworkTeam'

const tasks: TeamTask[] = [
  {
    id: 'alpha',
    description: 'rewrite the header',
    dependsOn: [],
    writes: ['team-target.txt'],
  },
  {
    id: 'beta',
    description: 'fix the footer',
    dependsOn: [],
    writes: ['team-target.txt'],
  },
]

function ask(signal?: AbortSignal): Promise<ConflictAnswer> {
  let pending!: Promise<ConflictAnswer>
  act(() => {
    pending = useTeamConflictRequests
      .getState()
      .request('s1', 'call-1', tasks, scopeConflicts(tasks), signal)
  })
  return pending
}

describe('CoworkTeamConflicts', () => {
  beforeEach(() => useTeamConflictRequests.setState({ bySession: {} }))

  it('shows nothing when no team is waiting', () => {
    render(<CoworkTeamConflicts sessionId="s1" />)
    expect(screen.queryByTestId('team-conflicts')).toBeNull()
  })

  it('names both tasks and the path, and waits for an answer to every overlap', async () => {
    render(<CoworkTeamConflicts sessionId="s1" />)
    const answered = ask()
    const region = await screen.findByRole('region', {
      name: 'Overlapping team tasks',
    })
    const row = within(region).getByTestId('team-conflict')
    expect(row.getAttribute('data-tasks')).toBe('alpha,beta')
    expect(within(row).getByTestId('team-conflict-path').textContent).toContain(
      'team-target.txt'
    )
    expect(row.textContent).toContain('rewrite the header')
    expect(row.textContent).toContain('fix the footer')
    // Nothing is decided until something is chosen.
    expect(screen.getByTestId('team-conflicts-continue')).toBeDisabled()

    await userEvent.click(
      within(row).getByRole('radio', { name: 'Run alpha first, then beta' })
    )
    await userEvent.click(screen.getByTestId('team-conflicts-continue'))
    const answer = await answered
    const key = conflictKey(scopeConflicts(tasks)[0])
    expect(answer).toEqual({
      kind: 'decided',
      decisions: { [key]: { kind: 'serialize', first: 'alpha', then: 'beta' } },
    })
    expect(screen.queryByTestId('team-conflicts')).toBeNull()
  })

  it('sends a revised scope as typed', async () => {
    render(<CoworkTeamConflicts sessionId="s1" />)
    const answered = ask()
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Change what beta may change' })
    )
    const field = screen.getByTestId('team-conflict-scope')
    await userEvent.clear(field)
    await userEvent.type(field, 'footer.txt, notes.md')
    await userEvent.click(screen.getByTestId('team-conflicts-continue'))
    const answer = await answered
    expect(answer.kind === 'decided' && Object.values(answer.decisions)[0]).toEqual({
      kind: 'revise',
      task: 'beta',
      writes: ['footer.txt', 'notes.md'],
    })
  })

  it('declining runs nothing, and a stopped run declines by itself', async () => {
    render(<CoworkTeamConflicts sessionId="s1" />)
    const answered = ask()
    await userEvent.click(await screen.findByTestId('team-conflicts-cancel'))
    expect(await answered).toEqual({ kind: 'cancel' })

    const stop = new AbortController()
    const again = ask(stop.signal)
    act(() => stop.abort())
    expect(await again).toEqual({ kind: 'cancel' })
    expect(useTeamConflictRequests.getState().bySession.s1).toBeUndefined()
  })
})
