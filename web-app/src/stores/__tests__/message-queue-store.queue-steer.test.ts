import { describe, it, expect, beforeEach } from 'vitest'
import { useMessageQueue } from '../message-queue-store'

const q = () => useMessageQueue.getState()
const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: id,
  createdAt: 1,
  ...extra,
})
const ids = (thread: string) => q().getQueue(thread).map((m) => m.id)

describe('queue or steer while a run works', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('keeps plain queued messages out of the running turn', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('A', msg('2'))
    expect(q().takeSteering('A')).toEqual([])
    expect(ids('A')).toEqual(['1', '2'])
  })

  it('hands the running turn only what the user chose to steer with, in order', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('A', msg('2'))
    q().enqueue('A', msg('3'))
    q().steerNow('A', '3')
    q().steerNow('A', '1')
    expect(q().takeSteering('A').map((m) => m.id)).toEqual(['1', '3'])
    // What stays goes as its own turn after the run.
    expect(ids('A')).toEqual(['2'])
  })

  it('always steers with mail from another session', () => {
    const from = { sessionId: 'S', displayName: 'S', messageId: 'm', depth: 0 }
    q().enqueue('A', msg('plain'))
    q().enqueue('A', msg('mail', { from }))
    expect(q().takeSteering('A').map((m) => m.id)).toEqual(['mail'])
    expect(ids('A')).toEqual(['plain'])
  })

  it('never steers with a held message, and holding forgets the steer choice', () => {
    q().enqueue('A', msg('1'))
    q().steerNow('A', '1')
    q().holdQueue('A')
    expect(q().getQueue('A')[0].steer).toBeUndefined()
    // Held: Steer now is refused, nothing is taken.
    q().steerNow('A', '1')
    expect(q().takeSteering('A')).toEqual([])
    // Released, it goes as a turn of its own.
    q().release('A', '1')
    expect(q().takeSteering('A')).toEqual([])
    expect(q().dequeueReady('A')?.id).toBe('1')
  })

  it('sends what is left one by one, in queue order', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('A', msg('2'))
    q().enqueue('A', msg('3'))
    const sent: string[] = []
    for (let m = q().dequeueReady('A'); m; m = q().dequeueReady('A')) {
      sent.push(m.id)
    }
    expect(sent).toEqual(['1', '2', '3'])
  })

  it('reorders within the queue and clamps at the ends', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('A', msg('2'))
    q().enqueue('A', msg('3'))
    q().move('A', '3', -1)
    expect(ids('A')).toEqual(['1', '3', '2'])
    q().move('A', '1', 1)
    expect(ids('A')).toEqual(['3', '1', '2'])
    const before = q().queues.A
    q().move('A', '3', -1)
    q().move('A', 'missing', 1)
    // No-op moves keep the same array, so selectors do not re-render.
    expect(q().queues.A).toBe(before)
    // Reordering decides what goes first after the run.
    expect(q().dequeueReady('A')?.id).toBe('3')
  })

  it('never moves or steers another thread', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('B', msg('b'))
    q().steerNow('B', '1')
    q().move('B', '1', 1)
    expect(q().takeSteering('A')).toEqual([])
    expect(ids('B')).toEqual(['b'])
  })
})
