import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createMailboxDelivery,
  dequeueClaimedReady,
  drainIdleSession,
  takeClaimed,
} from '../mailboxDelivery'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import { fakeMailbox, flush } from './mailboxFake'

const session = (id: string): CoworkSession =>
  ({ id, title: id, folder: '/proj', turns: [], messages: [], updated: 0 }) as CoworkSession

const q = (sid: string) => useMessageQueue.getState().getQueue(sid)
const setRunning = (sid: string, on: boolean) =>
  useCoworkRun.setState((s) => {
    const runs = { ...s.runs }
    if (on) runs[sid] = { runId: `run-${sid}`, startedAt: 1 }
    else delete runs[sid]
    return { runs }
  })

describe('mailbox delivery', () => {
  let fake: ReturnType<typeof fakeMailbox>
  let delivery: ReturnType<typeof createMailboxDelivery>
  let stop: () => void

  beforeEach(() => {
    useMessageQueue.setState({ queues: {} })
    useCoworkSessions.setState({
      sessions: [session('A'), session('B')],
      currentId: 'A',
    })
    useCoworkRun.setState({ runs: {} })
    useSessionMessaging.setState({ autoWake: {}, pendingWake: {}, lastRunWasWake: {} })
    fake = fakeMailbox()
    delivery = createMailboxDelivery(fake.mailbox)
    stop = delivery.start()
  })
  afterEach(() => stop())

  it('running recipient: takes and enqueues ready, attributed, wrapped', async () => {
    setRunning('A', true)
    fake.envelope('A', 'm1', { replyTo: 'm0', depth: 1 })
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    expect(fake.mailbox.takeForDelivery).toHaveBeenCalledTimes(1)
    expect(fake.mailbox.pending).not.toHaveBeenCalled()
    const [m] = q('A')
    expect(m.id).toBe('mail:m1')
    expect(m.held).toBe(false)
    expect(m.text).toMatch(/^\[Coordination message from session "Other session"/)
    expect(m.from).toEqual({
      sessionId: 'OTHER',
      displayName: 'Other session',
      messageId: 'm1',
      replyTo: 'm0',
      depth: 1,
    })
    expect(fake.state.m1).toBe('delivered')
  })

  it('idle recipient: holds without changing backend state, never auto-sent', async () => {
    fake.envelope('A', 'm1')
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    expect(fake.mailbox.takeForDelivery).not.toHaveBeenCalled()
    expect(q('A').map((m) => [m.id, m.held])).toEqual([['mail:m1', true]])
    expect(fake.state.m1).toBe('queued')
    expect(useMessageQueue.getState().dequeueReady('A')).toBeUndefined()
  })

  it('dedupes repeated events and repeated sweeps by message id', async () => {
    fake.envelope('A', 'm1')
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    await delivery.sweep()
    expect(q('A')).toHaveLength(1)
  })

  it('ignores an event for a session this app does not have', async () => {
    fake.envelope('Z', 'm1')
    await delivery.onEvent({ sessionId: 'Z', messageId: 'm1' })
    await delivery.onEvent(undefined)
    expect(fake.mailbox.pending).not.toHaveBeenCalled()
    expect(fake.mailbox.takeForDelivery).not.toHaveBeenCalled()
    expect(useMessageQueue.getState().queues).toEqual({})
  })

  it('startup sweep picks up mail for every session', async () => {
    fake.envelope('A', 'a1')
    fake.envelope('B', 'b1')
    await delivery.sweep()
    expect(q('A').map((m) => m.id)).toEqual(['mail:a1'])
    expect(q('B').map((m) => m.id)).toEqual(['mail:b1'])
  })

  it('takes each envelope exactly once across events, release and drain', async () => {
    setRunning('A', true)
    fake.envelope('A', 'm1')
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    setRunning('A', false) // run ends: ready mail is held again
    expect(q('A')[0].held).toBe(true)
    fake.envelope('A', 'm2')
    await delivery.onEvent({ sessionId: 'A', messageId: 'm2' })
    useMessageQueue.getState().release('A', 'mail:m2')
    await flush()
    useMessageQueue.getState().release('A', 'mail:m1')
    await flush()
    expect(fake.takenTimes).toEqual({ m1: 1, m2: 1 })
    // Drained by the runner at a boundary: marked read, never resurfaces.
    useMessageQueue.getState().takeReady('A')
    await flush()
    expect(fake.state).toEqual({ m1: 'read', m2: 'read' })
    await delivery.sweep()
    expect(q('A')).toEqual([])
  })

  it('release marks delivered; drain marks read', async () => {
    fake.envelope('A', 'm1')
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    useMessageQueue.getState().release('A', 'mail:m1')
    await flush()
    expect(fake.state.m1).toBe('delivered')
    useMessageQueue.getState().dequeueReady('A')
    await flush()
    expect(fake.state.m1).toBe('read')
  })

  it('auto-wake off holds; on releases only for the focused session', async () => {
    useSessionMessaging.getState().setAutoWake('B', true)
    fake.envelope('B', 'b1')
    await delivery.onEvent({ sessionId: 'B', messageId: 'b1' })
    // B is not in view: held even with auto-wake on.
    expect(q('B')[0].held).toBe(true)
    useCoworkSessions.getState().selectSession('B')
    expect(q('B')[0].held).toBe(false)
    expect(useSessionMessaging.getState().pendingWake.B).toBe(true)
    await flush()
    expect(fake.state.b1).toBe('delivered')

    fake.envelope('A', 'a1')
    useCoworkSessions.getState().selectSession('A')
    await delivery.onEvent({ sessionId: 'A', messageId: 'a1' })
    expect(q('A')[0].held).toBe(true)
  })

  it('auto-wakes a session open in a split-view pane, not only the current one', async () => {
    const { useSplitConversation } = await import(
      '@/hooks/useSplitConversation'
    )
    useSplitConversation.setState({ panes: [], sizes: [1] })
    try {
      useSessionMessaging.getState().setAutoWake('B', true)
      fake.envelope('B', 'b1')
      await delivery.onEvent({ sessionId: 'B', messageId: 'b1' })
      expect(q('B')[0].held).toBe(true)
      // Opening B in a pane beside A brings it into view.
      useSplitConversation.getState().addPane({ kind: 'cowork', refId: 'B' })
      expect(useCoworkSessions.getState().currentId).toBe('A')
      expect(q('B')[0].held).toBe(false)
      await flush()
      expect(fake.state.b1).toBe('delivered')

      // Mail arriving while B is already in its pane wakes it too.
      fake.envelope('B', 'b2')
      await delivery.onEvent({ sessionId: 'B', messageId: 'b2' })
      expect(q('B').find((m) => m.id === 'mail:b2')?.held).toBe(false)
    } finally {
      useSplitConversation.setState({ panes: [], sizes: [1] })
    }
  })

  it('does not auto-wake on a reply while the last run was itself a wake-up', async () => {
    useSessionMessaging.getState().setAutoWake('A', true)
    // A wake-up released mail; the run it started is marked as a wake.
    useSessionMessaging.getState().markWakeRequested('A')
    setRunning('A', true)
    setRunning('A', false)
    expect(useSessionMessaging.getState().lastRunWasWake.A).toBe(true)

    fake.envelope('A', 'reply', { depth: 1, replyTo: 'x' })
    fake.envelope('A', 'fresh', { depth: 0 })
    await delivery.onEvent({ sessionId: 'A', messageId: 'reply' })
    expect(q('A').map((m) => [m.id, m.held])).toEqual([
      ['mail:reply', true],
      ['mail:fresh', false],
    ])

    // A run the user started (nothing released by a wake-up) clears the guard.
    useMessageQueue.setState({ queues: {} })
    useSessionMessaging.setState({ pendingWake: {} })
    setRunning('A', true)
    setRunning('A', false)
    expect(useSessionMessaging.getState().lastRunWasWake.A).toBe(false)
  })

  it('a reply consumed by wait_for_reply or read_messages is not re-injected by steering', async () => {
    setRunning('A', true)
    fake.envelope('A', 'r1', { replyTo: 'q1', depth: 1 })
    await delivery.onEvent({ sessionId: 'A', messageId: 'r1' })
    expect(q('A').map((m) => [m.id, m.held])).toEqual([['mail:r1', false]])
    // The agent's wait_for_reply returned it and marked it read in the backend.
    fake.state.r1 = 'read'
    const taken = await takeClaimed(
      'A',
      () => useMessageQueue.getState().takeReady('A'),
      fake.mailbox
    )
    expect(taken).toEqual([])
    expect(q('A')).toEqual([])
  })

  it('steering claims unconsumed mail exactly once and keeps typed input', async () => {
    setRunning('A', true)
    fake.envelope('A', 'm1')
    await delivery.onEvent({ sessionId: 'A', messageId: 'm1' })
    useMessageQueue.getState().enqueue('A', { id: 'typed', text: 'mine', createdAt: 2 })
    const taken = await takeClaimed(
      'A',
      () => useMessageQueue.getState().takeReady('A'),
      fake.mailbox
    )
    await flush()
    expect(taken.map((m) => m.id)).toEqual(['mail:m1', 'typed'])
    expect(fake.state.m1).toBe('read')
    expect(fake.mailbox.claim).toHaveBeenCalledWith('A', ['m1'])
    // The claim marked it read; the queue subscriber did not race it.
    expect(fake.mailbox.markRead).not.toHaveBeenCalled()
    // Claimed again (a second drain of the same id): nothing comes back.
    expect(await fake.mailbox.claim('A', ['m1'])).toEqual([])
  })

  it('idle dequeue skips consumed mail and sends the next claimed message', async () => {
    fake.envelope('A', 'a1')
    fake.envelope('A', 'a2')
    await delivery.onEvent({ sessionId: 'A', messageId: 'a1' })
    useMessageQueue.getState().release('A', 'mail:a1')
    useMessageQueue.getState().release('A', 'mail:a2')
    await flush()
    fake.state.a1 = 'read' // read_messages consumed it
    const next = await dequeueClaimedReady('A', fake.mailbox)
    expect(next?.id).toBe('mail:a2')
    expect(fake.state.a2).toBe('read')
    expect(q('A')).toEqual([])
    expect(await dequeueClaimedReady('A', fake.mailbox)).toBeUndefined()
  })

  it('never sends a drained message into a session switched to mid-claim', async () => {
    fake.envelope('A', 'w1')
    await delivery.onEvent({ sessionId: 'A', messageId: 'w1' })
    useMessageQueue.getState().release('A', 'mail:w1')
    await flush()
    // The claim is a round trip; the user moves to B while it is in flight.
    const realClaim = fake.mailbox.claim.getMockImplementation()!
    fake.mailbox.claim.mockImplementationOnce(async (sid: string, ids: string[]) => {
      useCoworkSessions.setState({ currentId: 'B' })
      return realClaim(sid, ids)
    })
    const sent: Array<[string, string | undefined]> = []
    const run = (text: string, from?: { sessionId: string }) =>
      sent.push([useCoworkSessions.getState().currentId ?? '', from?.sessionId])

    await drainIdleSession('A', run, fake.mailbox)
    expect(sent).toEqual([])
    // Back in A's queue, still ready.
    expect(q('A').map((m) => [m.id, m.held])).toEqual([['mail:w1', false]])
    expect(q('B')).toEqual([])

    // Returning to A sends it there, without being dropped as already read.
    useCoworkSessions.setState({ currentId: 'A' })
    await drainIdleSession('A', run, fake.mailbox)
    expect(sent.map(([into]) => into)).toEqual(['A'])
    expect(q('A')).toEqual([])
  })

  it('leaves normal held input alone', async () => {
    useMessageQueue.getState().enqueue('A', { id: 'typed', text: 'mine', createdAt: 1 })
    useMessageQueue.getState().holdQueue('A')
    useSessionMessaging.getState().setAutoWake('A', true)
    setRunning('A', true)
    setRunning('A', false)
    expect(q('A')).toEqual([{ id: 'typed', text: 'mine', createdAt: 1, held: true }])
    expect(fake.mailbox.markRead).not.toHaveBeenCalled()
  })
})
