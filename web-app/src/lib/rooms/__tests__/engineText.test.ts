import { describe, expect, it } from 'vitest'
import { chunkTranscript } from '../engine'
import { clipMiddle, modelKey, sameFiles, settleAfterCommand } from '../engineText'

describe('engineText', () => {
  it('chunks blocks into passes that fit, keeping order', () => {
    const { chunks, omitted } = chunkTranscript(['aaaa', 'bbbb', 'cccc'], 16)
    expect(chunks).toEqual(['aaaa\n\nbbbb', 'cccc'])
    expect(omitted).toBe(0)
  })

  it('keeps the newest six passes and counts the omitted', () => {
    const blocks = Array.from({ length: 9 }, (_, i) => `block-${i}`)
    const { chunks, omitted } = chunkTranscript(blocks, 8)
    expect(chunks).toHaveLength(6)
    expect(omitted).toBe(3)
    expect(chunks[5]).toBe('block-8')
  })

  it('clips the middle of a long block only', () => {
    expect(clipMiddle('short', 100)).toBe('short')
    const out = clipMiddle('x'.repeat(200), 64)
    expect(out).toContain('\n... (cut) ...\n')
    expect(out.length).toBeLessThan(200)
  })

  it('settles completed, awaiting-user and stopped rooms as they were, others paused', () => {
    expect(settleAfterCommand('completed')).toBe('completed')
    expect(settleAfterCommand('awaiting-user')).toBe('awaiting-user')
    expect(settleAfterCommand('stopped')).toBe('stopped')
    expect(settleAfterCommand('running')).toBe('paused')
  })

  it('compares change listings by path and counts, ignoring order', () => {
    const a = { path: 'a.ts', additions: 1, deletions: 0 }
    const b = { path: 'b.ts', additions: 2, deletions: 3 }
    expect(sameFiles([a, b], [b, a])).toBe(true)
    expect(sameFiles([a], [{ ...a, additions: 2 }])).toBe(false)
    expect(sameFiles([a], [a, b])).toBe(false)
  })

  it('names a model by provider and id', () => {
    expect(modelKey({ provider: 'p', id: 'm' })).toBe('p/m')
  })
})
