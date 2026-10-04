import { describe, it, expect } from 'vitest'
import {
  costBreakdown,
  formatUsd,
  isFree,
  replyCost,
  resolvePricing,
  type Pricing,
} from '../modelPricing'

const sonnet: Pricing = { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }

describe('costBreakdown', () => {
  it('prices cached, new, written and output tokens each at their own rate', () => {
    const c = costBreakdown(sonnet, {
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      cacheWriteTokens: 5_000,
      outputTokens: 2_000,
    })
    expect(c.cachedInput).toBeCloseTo(0.024, 10)
    expect(c.cacheWrite).toBeCloseTo(0.01875, 10)
    expect(c.newInput).toBeCloseTo(0.045, 10)
    expect(c.output).toBeCloseTo(0.03, 10)
    expect(c.total).toBeCloseTo(0.024 + 0.01875 + 0.045 + 0.03, 10)
    expect(c.cachedPriced).toBe(true)
    expect(c.writePriced).toBe(true)
  })

  it('never charges a token twice: the three input kinds add up to the input', () => {
    const flat: Pricing = { input: 2, output: 0 }
    const c = costBreakdown(flat, {
      inputTokens: 1_000_000,
      cachedInputTokens: 600_000,
      cacheWriteTokens: 100_000,
    })
    expect(c.cachedInput + c.newInput + c.cacheWrite).toBeCloseTo(2, 10)
  })

  it('saves what the cached tokens would have cost at the full price, less what they cost', () => {
    const c = costBreakdown(sonnet, { inputTokens: 100_000, cachedInputTokens: 100_000 })
    expect(c.savings).toBeCloseTo((100_000 * (3 - 0.3)) / 1e6, 10)
    // Without caching the reply would have cost 0.30; caching cut 90% of it.
    expect(c.savingsPercent).toBeCloseTo(90, 8)
  })

  it('falls back to the input price when no cached price is set, and saves nothing', () => {
    const c = costBreakdown(
      { input: 3, output: 15 },
      { inputTokens: 10_000, cachedInputTokens: 9_000, cacheWriteTokens: 500 }
    )
    expect(c.cachedPriced).toBe(false)
    expect(c.writePriced).toBe(false)
    expect(c.cachedInput).toBeCloseTo(0.027, 10)
    expect(c.cacheWrite).toBeCloseTo(0.0015, 10)
    expect(c.savings).toBe(0)
    expect(c.savingsPercent).toBe(0)
    expect(c.total).toBeCloseTo(0.03, 10)
  })

  it('a cached price of zero is a price: cached input is free', () => {
    const c = costBreakdown(
      { input: 3, output: 15, cachedInput: 0 },
      { inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }
    )
    expect(c.cachedPriced).toBe(true)
    expect(c.cachedInput).toBe(0)
    expect(c.savings).toBeCloseTo(3, 10)
  })

  it('is zero for nothing, and ignores junk counts', () => {
    expect(costBreakdown(sonnet, {}).total).toBe(0)
    const junk = costBreakdown(sonnet, {
      inputTokens: Number.NaN,
      cachedInputTokens: -5,
      outputTokens: Infinity,
    })
    expect(junk.total).toBe(0)
    expect(junk.savingsPercent).toBe(0)
  })

  it('clamps cached to the input, and writes to what was not cached', () => {
    const c = costBreakdown(sonnet, {
      inputTokens: 1_000,
      cachedInputTokens: 5_000,
      cacheWriteTokens: 5_000,
    })
    expect(c.cachedInput).toBeCloseTo((1_000 * 0.3) / 1e6, 12)
    expect(c.cacheWrite).toBe(0)
    expect(c.newInput).toBe(0)
  })
})

describe('replyCost', () => {
  it('is what it always was without cache counts', () => {
    expect(replyCost({ input: 2, output: 8 }, 1_000_000, 500_000)).toBeCloseTo(6, 10)
    expect(replyCost(null, 1_000_000, 500_000)).toBe(0)
  })

  it('is cache-aware when it is given the cache counts', () => {
    const plain = replyCost(sonnet, 100_000, 2_000)
    const cached = replyCost(sonnet, 100_000, 2_000, { cachedInputTokens: 80_000 })
    expect(cached).toBeLessThan(plain)
    expect(plain - cached).toBeCloseTo((80_000 * (3 - 0.3)) / 1e6, 10)
  })

  it('agrees with the breakdown total', () => {
    const t = { inputTokens: 123_456, outputTokens: 789, cachedInputTokens: 100_000, cacheWriteTokens: 3_000 }
    expect(replyCost(sonnet, t.inputTokens, t.outputTokens, t)).toBeCloseTo(
      costBreakdown(sonnet, t).total,
      12
    )
  })

  it('with no cached price equals the old input-times-price figure', () => {
    const p: Pricing = { input: 3, output: 15 }
    expect(replyCost(p, 100_000, 2_000, { cachedInputTokens: 90_000 })).toBeCloseTo(
      replyCost(p, 100_000, 2_000),
      12
    )
  })
})

describe('resolvePricing with cache prices', () => {
  it('carries a model’s own cached and write prices', () => {
    expect(
      resolvePricing('openai', {
        id: 'x',
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        cachedInputCostPerMillion: 0.3,
        cacheWriteCostPerMillion: 3.75,
      })
    ).toEqual(sonnet)
  })

  it('leaves them out when unset or invalid', () => {
    const p = resolvePricing('openai', {
      id: 'x',
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      cachedInputCostPerMillion: -1,
    })
    expect(p).toEqual({ input: 3, output: 15 })
  })

  it('adds a user’s cached price to a well-known model’s built-in price', () => {
    const p = resolvePricing('anthropic', { id: 'claude-sonnet-4', cachedInputCostPerMillion: 0.3 })
    expect(p).toEqual({ input: 3, output: 15, cachedInput: 0.3 })
  })

  it('treats a local model as free, and an unknown one as unpriced', () => {
    expect(isFree(resolvePricing('llamacpp', { id: 'qwen' }))).toBe(true)
    expect(resolvePricing('custom', { id: 'mystery' })).toBeNull()
    expect(isFree(null)).toBe(false)
    expect(isFree(sonnet)).toBe(false)
  })
})

describe('formatUsd', () => {
  it('shows small amounts to four places and larger ones to two', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0123456)).toBe('$0.0123')
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatUsd(0.00001)).toBe('<$0.0001')
    expect(formatUsd(Number.NaN)).toBe('$0.00')
  })
})
