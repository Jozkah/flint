import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPresenceSync,
  notifySessionArchived,
  notifySessionRemoved,
  notifySessionRestored,
  __presenceTesting,
} from '../mailboxPresence'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const session = (id: string, title = id, folder: string | null = null): CoworkSession =>
  ({ id, title, folder, turns: [], messages: [], updated: 0 }) as CoworkSession

const fake = () => ({
  register: vi.fn(async () => undefined),
  setStatus: vi.fn(async () => undefined),
  heartbeat: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  revive: vi.fn(async () => undefined),
  setWaiting: vi.fn(async () => undefined),
  setArchived: vi.fn(async () => undefined),
})

describe('mailbox presence', () => {
  let mailbox: ReturnType<typeof fake>
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    __presenceTesting.reset()
    useCoworkSessions.setState({ sessions: [session('A', 'Alpha', '/p')], currentId: 'A' })
    useCoworkRun.setState({ runs: {} })
    useSessionMessaging.setState({ optOut: {} })
    useToolApprovalRequests.setState({ pending: {} })
    mailbox = fake()
    stop = createPresenceSync(mailbox, { debounceMs: 100, heartbeatMs: 30_000 }).start()
  })
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('registers existing sessions, debounced', () => {
    expect(mailbox.register).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: true,
    })
  })

  it('says how a session works in its folder, and re-registers when that changes', () => {
    vi.advanceTimersByTime(100)
    mailbox.register.mockClear()
    useCoworkSessions.setState({
      sessions: [{ ...session('A', 'Alpha', '/p'), access: 'review-only' }],
    })
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: true,
      access: 'review-only',
      isolated: false,
    })
    // Moved into its own worktree: marked isolated.
    useCoworkSessions.setState({
      sessions: [{ ...session('A', 'Alpha', '/p'), access: 'managed-worktree' }],
    })
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: true,
      access: 'managed-worktree',
      isolated: true,
    })
  })

  it('registers a new session, and a rename or folder change once each', () => {
    vi.advanceTimersByTime(100)
    mailbox.register.mockClear()
    useCoworkSessions.setState((s) => ({ sessions: [session('B'), ...s.sessions] }))
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenCalledTimes(1)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'B',
      displayName: 'B',
      folder: null,
      acceptsMessages: true,
    })

    // Typing a title: many updates, one registration with the final value.
    for (const t of ['R', 'Re', 'Renamed']) {
      useCoworkSessions.getState().setTitle('A', t)
      vi.advanceTimersByTime(30)
    }
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenCalledTimes(2)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Renamed',
      folder: '/p',
      acceptsMessages: true,
    })

    useCoworkSessions.getState().setFolder('A', '/other')
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Renamed',
      folder: '/other',
      acceptsMessages: true,
      // Attaching a folder gives the session an access mode, which is sent.
      access: 'edit-folder',
      isolated: false,
    })

    // An unrelated change registers nothing.
    useCoworkSessions.getState().setTodos('A', { phases: [] })
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenCalledTimes(3)
  })

  it('removes a deleted session once, whichever path sees it first', () => {
    notifySessionRemoved('A')
    useCoworkSessions.getState().deleteSession('A')
    vi.advanceTimersByTime(100)
    expect(mailbox.remove).toHaveBeenCalledTimes(1)
    expect(mailbox.remove).toHaveBeenCalledWith('A')
  })

  it('does not tombstone an archived session, and registers it again on restore', () => {
    vi.advanceTimersByTime(100)
    mailbox.register.mockClear()
    const archived = useCoworkSessions.getState().sessions[0]
    notifySessionArchived('A')
    useCoworkSessions.getState().deleteSession('A', { keepRecords: true })
    vi.advanceTimersByTime(100)
    expect(mailbox.remove).not.toHaveBeenCalled()
    // The backend is told, so mail to it is refused and discovery hides it.
    expect(mailbox.setArchived).toHaveBeenCalledWith('A', true)

    notifySessionRestored('A')
    expect(mailbox.setArchived).toHaveBeenLastCalledWith('A', false)
    useCoworkSessions.getState().restoreSession(archived)
    vi.advanceTimersByTime(100)
    expect(mailbox.register).toHaveBeenCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: true,
    })
    // A real delete afterwards still tombstones.
    useCoworkSessions.getState().deleteSession('A')
    expect(mailbox.remove).toHaveBeenCalledWith('A')
  })

  it('revives a live session whose registration hit an old tombstone, once', async () => {
    const { MailboxError } = await import('@/lib/sessionMailbox')
    mailbox.register.mockRejectedValue(new MailboxError('session_deleted', 'deleted'))
    vi.advanceTimersByTime(100)
    await vi.runOnlyPendingTimersAsync()
    expect(mailbox.revive).toHaveBeenCalledTimes(1)
    expect(mailbox.revive).toHaveBeenCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: true,
    })
    // A rename registers again; still refused, but no second revive.
    useCoworkSessions.getState().setTitle('A', 'Alpha 2')
    vi.advanceTimersByTime(100)
    await vi.runOnlyPendingTimersAsync()
    expect(mailbox.revive).toHaveBeenCalledTimes(1)
  })

  it('leaves a really deleted session tombstoned', async () => {
    const { MailboxError } = await import('@/lib/sessionMailbox')
    mailbox.register.mockImplementation(async () => {
      // Deleted from the store while the register was in flight.
      useCoworkSessions.setState({ sessions: [] })
      throw new MailboxError('session_deleted', 'deleted')
    })
    vi.advanceTimersByTime(100)
    await vi.runOnlyPendingTimersAsync()
    expect(mailbox.revive).not.toHaveBeenCalled()
  })

  it('reports running with heartbeats, then idle', async () => {
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(0)
    useCoworkRun.getState().startRun('A', 'r1')
    expect(mailbox.setStatus).toHaveBeenCalledWith({ sessionId: 'A', running: true, runId: 'r1' })
    vi.advanceTimersByTime(30_000)
    vi.advanceTimersByTime(30_000)
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(2)
    expect(mailbox.heartbeat).toHaveBeenCalledWith({ sessionId: 'A', runId: 'r1' })
    useCoworkRun.getState().finishRun('A', 'r1', null)
    expect(mailbox.setStatus).toHaveBeenLastCalledWith({ sessionId: 'A', running: false, runId: 'r1' })
    vi.advanceTimersByTime(90_000)
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(2)
  })

  it('ends a replaced run by its own id before reporting the new one', async () => {
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(0)
    useCoworkRun.getState().startRun('A', 'r1')
    useCoworkRun.getState().startRun('A', 'r2')
    expect(mailbox.setStatus.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { sessionId: 'A', running: true, runId: 'r1' },
      { sessionId: 'A', running: false, runId: 'r1' },
      { sessionId: 'A', running: true, runId: 'r2' },
    ])
  })

  it('registers a session before its first status when the run starts inside the debounce', async () => {
    const calls: string[] = []
    mailbox.register.mockImplementation(async () => {
      await Promise.resolve()
      calls.push('register')
    })
    mailbox.setStatus.mockImplementation(async () => {
      calls.push('status')
    })
    // The session was created and its run began before the 100 ms debounce.
    useCoworkRun.getState().startRun('A', 'r1')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['register', 'status'])
    // The debounce firing later registers nothing twice.
    await vi.advanceTimersByTimeAsync(200)
    expect(mailbox.register).toHaveBeenCalledTimes(1)
  })

  it('still reports the run when its registration fails', async () => {
    mailbox.register.mockRejectedValue(new Error('nope'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useCoworkRun.getState().startRun('A', 'r1')
    await vi.advanceTimersByTimeAsync(0)
    expect(mailbox.setStatus).toHaveBeenCalledWith({ sessionId: 'A', running: true, runId: 'r1' })
    warn.mockRestore()
  })

  it('registers the opt-out at once, and keeps it across a rename', async () => {
    await vi.advanceTimersByTimeAsync(100)
    mailbox.register.mockClear()
    useSessionMessaging.getState().setAcceptsMessages('A', false)
    await vi.advanceTimersByTimeAsync(0)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: false,
    })
    useCoworkSessions.getState().setTitle('A', 'Alpha 2')
    await vi.advanceTimersByTimeAsync(100)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Alpha 2',
      folder: '/p',
      acceptsMessages: false,
    })
  })

  it('registers an inbound hold at once, and drops it when the session refuses', async () => {
    await vi.advanceTimersByTimeAsync(100)
    mailbox.register.mockClear()
    useSessionMessaging.getState().setHoldInbound('A', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: true,
      inbound: 'hold',
    })
    // Refusing wins over holding, and is the old flag alone.
    useSessionMessaging.getState().setAcceptsMessages('A', false)
    await vi.advanceTimersByTimeAsync(0)
    expect(mailbox.register).toHaveBeenLastCalledWith({
      sessionId: 'A',
      displayName: 'Alpha',
      folder: '/p',
      acceptsMessages: false,
    })
    useSessionMessaging.setState({ optOut: {}, holdInbound: {} })
  })

  it('reports an approval wait while running, and clears it', async () => {
    await vi.advanceTimersByTimeAsync(100)
    useCoworkRun.getState().startRun('A', 'r1')
    await vi.advanceTimersByTimeAsync(0)
    useToolApprovalRequests.setState({
      pending: { c1: { threadId: 'A', toolName: 'bash' } as never },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mailbox.setWaiting).toHaveBeenLastCalledWith({
      sessionId: 'A',
      runId: 'r1',
      waiting: true,
    })
    useToolApprovalRequests.setState({ pending: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(mailbox.setWaiting).toHaveBeenLastCalledWith({
      sessionId: 'A',
      runId: 'r1',
      waiting: false,
    })
    expect(mailbox.setWaiting).toHaveBeenCalledTimes(2)
  })

  it('does not report a wait for a session that is not running', async () => {
    await vi.advanceTimersByTimeAsync(100)
    useToolApprovalRequests.setState({
      pending: { c1: { threadId: 'A', toolName: 'bash' } as never },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mailbox.setWaiting).not.toHaveBeenCalled()
  })

  it('never throws into the UI when the backend fails', async () => {
    mailbox.setStatus.mockRejectedValue(new Error('down'))
    mailbox.register.mockImplementation(() => {
      throw new Error('sync throw')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => useCoworkRun.getState().startRun('A', 'r2')).not.toThrow()
    expect(() => vi.advanceTimersByTime(100)).not.toThrow()
    await vi.runOnlyPendingTimersAsync()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
