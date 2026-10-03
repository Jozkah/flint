import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { compactHistory } from '../compaction'
import {
  MAX_RAPID_REFILLS,
  RAPID_REFILL_MESSAGES,
  cancelPrecompute,
  isCompactionLooping,
  recordCompaction,
  resetCompactionBreaker,
  startPrecompute,
  takePrecomputed,
} from '../compactionGuard'

const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

const convo = (n: number): UIMessage[] =>
  Array.from({ length: n }, (_, i) =>
    msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
  )

describe('rapid-refill breaker', () => {
  beforeEach(() => resetCompactionBreaker('t'))

  it('allows the first compaction and the first rapid refill', () => {
    expect(isCompactionLooping('t', 40)).toBe(false)
    recordCompaction('t', 40, 6)
    expect(isCompactionLooping('t', 6 + 1)).toBe(false)
  })

  it('stops after consecutive rapid refills', () => {
    let count = 6
    recordCompaction('t', 40, count)
    for (let i = 1; i < MAX_RAPID_REFILLS; i++) {
      const hit = count + RAPID_REFILL_MESSAGES
      expect(isCompactionLooping('t', hit)).toBe(false)
      recordCompaction('t', hit, 6)
      count = 6
    }
    expect(isCompactionLooping('t', count + 1)).toBe(true)
  })

  it('does not trip when the conversation grew well past the compaction', () => {
    recordCompaction('t', 40, 6)
    recordCompaction('t', 6 + 1, 6)
    expect(isCompactionLooping('t', 6 + RAPID_REFILL_MESSAGES + 5)).toBe(false)
  })

  it('tracks threads separately and resets', () => {
    recordCompaction('t', 40, 6)
    recordCompaction('t', 7, 6)
    expect(isCompactionLooping('other', 7)).toBe(false)
    expect(isCompactionLooping('t', 7)).toBe(true)
    resetCompactionBreaker('t')
    expect(isCompactionLooping('t', 7)).toBe(false)
  })
})

describe('precomputed summary', () => {
  beforeEach(() => cancelPrecompute('p'))

  it('starts once and is reused for the same prefix', async () => {
    const summarize = vi.fn(async () => 'early summary')
    const covered = convo(6)
    startPrecompute('p', covered, summarize)
    startPrecompute('p', covered, summarize)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(await takePrecomputed('p', covered)).toBe('early summary')
    expect(takePrecomputed('p', covered)).toBeNull()
  })

  it('is not reused when the covered prefix changed', () => {
    startPrecompute('p', convo(6), async () => 's')
    expect(takePrecomputed('p', convo(8))).toBeNull()
    const edited = convo(6)
    edited[2] = msg('m2', 'user', 'edited text that is longer')
    expect(takePrecomputed('p', edited)).toBeNull()
  })

  it('aborts a running precompute when cancelled', async () => {
    let signal: AbortSignal | undefined
    startPrecompute('p', convo(6), (_t, s) => {
      signal = s
      return new Promise(() => {})
    })
    cancelPrecompute('p')
    expect(signal?.aborted).toBe(true)
    expect(takePrecomputed('p', convo(6))).toBeNull()
  })

  it('resolves null when the background summary fails', async () => {
    const covered = convo(6)
    startPrecompute('p', covered, async () => {
      throw new Error('boom')
    })
    expect(await takePrecomputed('p', covered)).toBeNull()
  })
})

describe('compactHistory with a precomputed summary', () => {
  it('uses the reused summary instead of calling the model', async () => {
    const summarize = vi.fn(async () => 'sync')
    const result = await compactHistory(convo(14), {
      summarize,
      keepRecent: 4,
      reason: 'threshold',
      reuse: () => Promise.resolve('<analysis>a</analysis><summary>ready</summary>'),
    })
    expect(summarize).not.toHaveBeenCalled()
    expect(result?.record.summary).toBe('ready')
  })

  it('falls back to summarizing when the reuse comes back empty', async () => {
    const summarize = vi.fn(async () => '<summary>fresh</summary>')
    const result = await compactHistory(convo(14), {
      summarize,
      keepRecent: 4,
      reason: 'threshold',
      reuse: () => Promise.resolve(null),
    })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(result?.record.summary).toBe('fresh')
  })
})
