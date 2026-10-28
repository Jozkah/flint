import { beforeEach, describe, expect, it } from 'vitest'
import { isMethodNotFound } from '@/lib/deadTools'
import { dismissNotCarried, notCarriedDismissed } from '@/lib/coworkWorktrees'
import { isSteering, useMessageQueue } from '@/stores/message-queue-store'

describe('isMethodNotFound', () => {
  it('finds the JSON-RPC code in a serialized error', () => {
    expect(isMethodNotFound('{"code":-32601,"message":"nicht gefunden"}')).toBe(
      true
    )
    expect(isMethodNotFound('code -326010 is something else')).toBe(false)
  })
})

describe('message queue hold', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('a held steering message is not steering after release', () => {
    const s = useMessageQueue.getState()
    s.enqueue('t', { id: 'm1', text: 'x', createdAt: 1 })
    useMessageQueue.getState().steerNow('t', 'm1')
    useMessageQueue.getState().hold('t', 'm1')
    useMessageQueue.getState().release('t', 'm1')
    const msg = useMessageQueue.getState().getQueue('t')[0]
    expect(isSteering(msg)).toBe(false)
  })
})

describe('dismissNotCarried', () => {
  beforeEach(() => localStorage.clear())

  it('keeps only the newest 200 dismissals', () => {
    for (let i = 0; i < 205; i++) dismissNotCarried(`s${i}`)
    expect(notCarriedDismissed('s0')).toBe(false)
    expect(notCarriedDismissed('s204')).toBe(true)
  })
})
