import { describe, it, expect } from 'vitest'
import { peekBatches } from '../peekBatches'

describe('peekBatches', () => {
  it('covers every room, newest first, in groups', () => {
    const summaries = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      updatedAt: i,
    }))
    const batches = peekBatches(summaries, 12)
    expect(batches.map((b) => b.length)).toEqual([12, 12, 6])
    expect(batches[0][0]).toBe('r29')
    expect(batches.flat()).toHaveLength(30)
    expect(new Set(batches.flat()).size).toBe(30)
  })

  it('returns nothing for no rooms', () => {
    expect(peekBatches([])).toEqual([])
  })
})
