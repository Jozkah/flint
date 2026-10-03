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
  MAX_STALE_PREFIX_MESSAGES,
  startPrecompute,
  takePrecomputed,
  takePrecomputedPrefix,
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

describe('one background summary per thread and covered prefix', () => {
  beforeEach(() => cancelPrecompute('p'))

  it('summarizes once while the conversation grows through the band, and compaction uses it', async () => {
    const summarize = vi.fn(async () => '<summary>S</summary>')
    // Five turns in the 80-100% band: each covers a few more messages.
    for (let turn = 0; turn < 5; turn++) {
      startPrecompute('p', convo(10 + turn), summarize)
    }
    expect(summarize).toHaveBeenCalledTimes(1)

    // The compaction that follows covers two more messages than the summary.
    const covered = convo(12)
    const taken = takePrecomputedPrefix('p', covered)
    expect(taken?.count).toBe(10)
    expect(await taken?.summary).toBe('<summary>S</summary>')
    // Consumed: nothing is left to take twice.
    expect(takePrecomputedPrefix('p', covered)).toBeNull()
  })

  it('starts a new one once the conversation has run on past what is worth reusing', () => {
    const summarize = vi.fn(async () => 's')
    startPrecompute('p', convo(10), summarize)
    startPrecompute('p', convo(10 + MAX_STALE_PREFIX_MESSAGES), summarize)
    expect(summarize).toHaveBeenCalledTimes(1)
    startPrecompute('p', convo(10 + MAX_STALE_PREFIX_MESSAGES + 1), summarize)
    expect(summarize).toHaveBeenCalledTimes(2)
    // And the old one is no longer offered for a conversation far beyond it.
    expect(takePrecomputedPrefix('p', convo(10 + MAX_STALE_PREFIX_MESSAGES + 1))?.count).toBe(
      10 + MAX_STALE_PREFIX_MESSAGES + 1
    )
  })

  it('replaces a summary of messages that were edited, and aborts it if still running', () => {
    let signal: AbortSignal | undefined
    const summarize = vi.fn((_t: string, s?: AbortSignal) => {
      signal = s
      return new Promise<string>(() => {})
    })
    startPrecompute('p', convo(10), summarize)
    const edited = convo(10)
    edited[2] = msg('m2', 'user', 'edited into something else entirely')
    startPrecompute('p', edited, summarize)
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(signal?.aborted).toBe(false)
    expect(takePrecomputedPrefix('p', convo(10))).toBeNull()
  })

  it('compactHistory folds only what a precomputed prefix covers and keeps the rest', async () => {
    const history = convo(30)
    const reusePrefix = vi.fn(() => ({ count: 18, summary: Promise.resolve('<summary>P</summary>') }))
    const summarize = vi.fn(async () => 'never')
    const result = await compactHistory(history, {
      summarize,
      keepRecent: 8,
      reason: 'threshold',
      reusePrefix,
    })
    expect(summarize).not.toHaveBeenCalled()
    expect(result?.record.summary).toBe('P')
    expect(result?.record.summarizedCount).toBe(18)
    // Everything after the summarized prefix is still there, in order.
    const kept = result!.messages.slice(1).map((m) => m.id)
    expect(kept).toEqual(history.slice(18).map((m) => m.id))
  })
})
