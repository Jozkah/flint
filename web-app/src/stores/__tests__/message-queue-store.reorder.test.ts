import { describe, it, expect, beforeEach } from 'vitest'
import { useMessageQueue } from '../message-queue-store'

const q = () => useMessageQueue.getState()
const ids = (thread: string) => q().getQueue(thread).map((m) => m.id)

describe('drag-to-reorder queued messages', () => {
  beforeEach(() => {
    useMessageQueue.setState({ queues: {} })
    for (const id of ['1', '2', '3', '4'])
      q().enqueue('A', { id, text: id, createdAt: 1 })
  })

  it('moves a dragged message down to where it was dropped', () => {
    q().reorder('A', '1', '3')
    expect(ids('A')).toEqual(['2', '3', '1', '4'])
  })

  it('moves a dragged message up to where it was dropped', () => {
    q().reorder('A', '4', '2')
    expect(ids('A')).toEqual(['1', '4', '2', '3'])
  })

  it('ignores a drop on itself or on a message that is gone', () => {
    const before = q().getQueue('A')
    q().reorder('A', '2', '2')
    q().reorder('A', '2', 'missing')
    expect(q().getQueue('A')).toBe(before)
  })
})
