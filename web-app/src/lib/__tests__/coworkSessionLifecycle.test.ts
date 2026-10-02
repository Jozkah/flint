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

describe('archiving vs deleting, as the mailbox sees it', () => {
  it('archive never tombstones; delete does; restore re-registers', async () => {
    const { vi } = await import('vitest')
    const { createPresenceSync, __presenceTesting } = await import('@/lib/mailboxPresence')
    const { restoreCoworkSession } = await import('@/lib/coworkSessionLifecycle')
    const { sessionMailbox } = await import('@/lib/sessionMailbox')
    const revive = vi
      .spyOn(sessionMailbox, 'revive')
      .mockResolvedValue({} as never)
    vi.useFakeTimers()
    __presenceTesting.reset()
    const sessions = [session('A') as never as { id: string }]
    useCoworkSessions.setState({ sessions: sessions as never, currentId: 'A' })
    const mb = {
      register: vi.fn(async () => undefined),
      setStatus: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const stop = createPresenceSync(mb as never, { debounceMs: 10 }).start()
    vi.advanceTimersByTime(20)
    mb.register.mockClear()

    deleteCoworkSession('A', { keepRecords: true })
    expect(mb.remove).not.toHaveBeenCalled()

    restoreCoworkSession({ session: sessions[0] }, null)
    // Restore clears any backend tombstone (older builds left one).
    expect(revive).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'A' })
    )
    vi.advanceTimersByTime(20)
    expect(mb.register).toHaveBeenCalledTimes(1)

    deleteCoworkSession('A')
    expect(mb.remove).toHaveBeenCalledWith('A')
    stop()
    vi.useRealTimers()
  })
})
