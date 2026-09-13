import { beforeEach, describe, expect, it } from 'vitest'
import { beginRun, isRunning } from '@/lib/coworkRunner'
import { deleteCoworkSession } from '@/lib/coworkSessionLifecycle'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

/**
 * janhq/jan#8905: deleting a session that is running has to stop that run --
 * and only that run -- rather than leave it streaming into a session that no
 * longer exists.
 */

const session = (id: string) =>
  ({
    id,
    title: id,
    folder: null,
    turns: [],
    messages: [],
    subagents: [],
    created: 1,
    updated: 1,
  }) as never

describe('deleting a Cowork session', () => {
  beforeEach(() => {
    useCoworkSessions.setState({
      sessions: [session('A'), session('B')],
      currentId: 'A',
    })
    useCoworkRun.setState({ runs: {}, outcomes: {}, liveTurns: {} })
  })

  it('stops the deleted session’s run and leaves the other running', () => {
    const a = new AbortController()
    const b = new AbortController()
    beginRun('A', 'run-a', a)
    beginRun('B', 'run-b', b)
    useCoworkRun.getState().startRun('A', 'run-a')
    useCoworkRun.getState().startRun('B', 'run-b')

    deleteCoworkSession('A')

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(isRunning('A')).toBe(false)
    expect(isRunning('B')).toBe(true)
    expect(useCoworkRun.getState().runs.A).toBeUndefined()
    expect(useCoworkRun.getState().runs.B?.runId).toBe('run-b')
    expect(useCoworkSessions.getState().sessions.map((s) => s.id)).toEqual([
      'B',
    ])
  })

  it('refuses the deleted run’s late writes', () => {
    beginRun('A', 'run-a', new AbortController())
    useCoworkRun.getState().startRun('A', 'run-a')
    deleteCoworkSession('A')
    useCoworkRun
      .getState()
      .setRunTurns('A', 'run-a', [{ role: 'assistant', content: 'late' }])
    useCoworkRun.getState().finishRun('A', 'run-a', { stoppedBy: 'done' })
    expect(useCoworkRun.getState().liveTurns.A).toBeUndefined()
    expect(useCoworkRun.getState().outcomes.A).toBeUndefined()
  })
})
