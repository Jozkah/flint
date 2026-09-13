import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { createStopListener, STOP_ABORT_REASON } from '../sessionStopListener'
import type { StopRequest } from '../sessionMailbox'

const request = (over: Partial<StopRequest> = {}): StopRequest => ({
  v: 1,
  id: 'stop-1',
  from: { sessionId: 'A', displayName: 'Alpha' },
  to: { sessionId: 'B', displayName: 'Beta' },
  project: 'proj-1',
  reason: 'we both own src/x.ts',
  targetRunId: 'run-b1',
  createdAt: 1,
  status: 'requested',
  ...over,
})

const session = (id: string): CoworkSession =>
  ({ id, title: id, folder: '/p', turns: [], messages: [], updated: 0 }) as unknown as CoworkSession

function setup(record: StopRequest | null) {
  useCoworkSessions.setState({ sessions: [session('A'), session('B'), session('C')], currentId: 'A' })
  useCoworkRun.setState({
    runs: {
      A: { runId: 'run-a', startedAt: 1 },
      B: { runId: 'run-b1', startedAt: 1 },
      C: { runId: 'run-c', startedAt: 1 },
    },
  })
  const handles: Record<string, { runId: string }> = {
    A: { runId: 'run-a' },
    B: { runId: 'run-b1' },
    C: { runId: 'run-c' },
  }
  const mailbox = {
    pendingStop: vi.fn(async (sid: string, id: string) =>
      record && record.to.sessionId === sid && record.id === id ? record : null
    ),
    resolveStop: vi.fn(async (input: { applied: boolean }) => ({
      ...(record as StopRequest),
      status: input.applied ? ('applied' as const) : ('ignored_stale' as const),
    })),
  }
  // What the route does when a run is aborted: the run ends and is unregistered.
  const abort = vi.fn((sid: string) => {
    delete handles[sid]
    const runId = useCoworkRun.getState().runs[sid]?.runId
    if (runId) useCoworkRun.getState().finishRun(sid, runId, { stoppedBy: 'aborted' })
  })
  const listener = createStopListener({
    mailbox,
    abort,
    getHandle: (sid) => handles[sid],
    waitMs: 200,
  })
  return { listener, mailbox, abort }
}

const turnsOf = (id: string) =>
  useCoworkSessions.getState().sessions.find((s) => s.id === id)?.turns ?? []

describe('stop request listener', () => {
  beforeEach(() => {
    useCoworkRun.setState({ runs: {} })
  })

  it('aborts only the named session run, records who stopped it, and reports applied', async () => {
    const { listener, mailbox, abort } = setup(request())
    const out = await listener.onEvent({ sessionId: 'B', requestId: 'stop-1' })
    expect(out).toBe('applied')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledWith('B', STOP_ABORT_REASON)
    // The other sessions keep running.
    expect(Object.keys(useCoworkRun.getState().runs).sort()).toEqual(['A', 'C'])
    const row = turnsOf('B').at(-1)
    expect(row?.stopNotice).toMatchObject({
      requestId: 'stop-1',
      fromSessionId: 'A',
      fromName: 'Alpha',
      reason: 'we both own src/x.ts',
    })
    expect(turnsOf('A')).toEqual([])
    expect(mailbox.resolveStop).toHaveBeenCalledWith({
      sessionId: 'B',
      requestId: 'stop-1',
      applied: true,
      runId: 'run-b1',
    })
  })

  it('a request for an older run leaves the newer run going', async () => {
    const { listener, mailbox, abort } = setup(request({ targetRunId: 'run-b0' }))
    const out = await listener.onEvent({ sessionId: 'B', requestId: 'stop-1' })
    expect(out).toBe('ignored-stale')
    expect(abort).not.toHaveBeenCalled()
    expect(useCoworkRun.getState().runs.B?.runId).toBe('run-b1')
    expect(turnsOf('B')).toEqual([])
    expect(mailbox.resolveStop).toHaveBeenCalledWith({
      sessionId: 'B',
      requestId: 'stop-1',
      applied: false,
      runId: 'run-b1',
    })
  })

  it('a forged event with no backend record does nothing', async () => {
    const { listener, mailbox, abort } = setup(null)
    expect(await listener.onEvent({ sessionId: 'B', requestId: 'stop-forged' })).toBe('no-record')
    expect(abort).not.toHaveBeenCalled()
    expect(mailbox.resolveStop).not.toHaveBeenCalled()
    expect(useCoworkRun.getState().runs.B?.runId).toBe('run-b1')
  })

  it('an event naming an unrelated session never applies a request addressed elsewhere', async () => {
    // The record is for B; the event claims C.
    const { listener, abort, mailbox } = setup(request())
    expect(await listener.onEvent({ sessionId: 'C', requestId: 'stop-1' })).toBe('no-record')
    expect(abort).not.toHaveBeenCalled()
    expect(mailbox.resolveStop).not.toHaveBeenCalled()
    expect(useCoworkRun.getState().runs.C?.runId).toBe('run-c')
  })

  it('ignores malformed payloads and sessions this app does not have', async () => {
    const { listener, abort, mailbox } = setup(request())
    expect(await listener.onEvent(undefined)).toBe('invalid')
    expect(await listener.onEvent({ sessionId: '', requestId: 'x' })).toBe('invalid')
    expect(await listener.onEvent({ sessionId: 'Z', requestId: 'stop-1' })).toBe('unknown-session')
    expect(abort).not.toHaveBeenCalled()
    expect(mailbox.pendingStop).not.toHaveBeenCalled()
  })
})
