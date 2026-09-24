import { describe, expect, it } from 'vitest'
import {
  anthropicOutputCeiling,
  anthropicTakesAnExplicitBudget,
  clampAnthropicThinkingBudget,
  clampThinkingBudget,
} from '../thinkingBudget'

describe('clampThinkingBudget', () => {
  it('caps the budget at 80% of max output tokens', () => {
    expect(clampThinkingBudget(20000, 10000)).toBe(8000)
    expect(clampThinkingBudget(5000, 10000)).toBe(5000)
  })

  it('never goes below 1024', () => {
    expect(clampThinkingBudget(100, 10000)).toBe(1024)
    expect(clampThinkingBudget(5000, 1000)).toBe(1024)
  })

  it('caps unlimited (-1) when the output limit is known', () => {
    expect(clampThinkingBudget(-1, 4096)).toBe(3276)
  })

  it('leaves the budget alone when the output limit is unknown', () => {
    expect(clampThinkingBudget(-1, undefined)).toBe(-1)
    expect(clampThinkingBudget(50000, 0)).toBe(50000)
  })
})

describe('clampAnthropicThinkingBudget', () => {
  it('keeps the budget under the model output ceiling, with room to answer', () => {
    // Opus 4 / 4.1 top out at 32k, below the xhigh budget.
    expect(
      clampAnthropicThinkingBudget(32768, 'claude-opus-4-1-20250805')
    ).toBe(25600)
    expect(clampAnthropicThinkingBudget(32768, 'claude-opus-4-20250514')).toBe(
      25600
    )
    // Well inside the ceiling: unchanged.
    expect(clampAnthropicThinkingBudget(16384, 'claude-sonnet-4-5')).toBe(16384)
    expect(
      clampAnthropicThinkingBudget(32768, 'claude-3-7-sonnet-20250219')
    ).toBe(32768)
  })

  it('recognises the models that take an explicit budget', () => {
    expect(anthropicTakesAnExplicitBudget('claude-sonnet-4-5')).toBe(true)
    expect(anthropicTakesAnExplicitBudget('claude-opus-4-20250514')).toBe(true)
    expect(anthropicTakesAnExplicitBudget('claude-3-7-sonnet-20250219')).toBe(
      true
    )
    expect(anthropicTakesAnExplicitBudget('claude-opus-4-6')).toBe(false)
    expect(anthropicTakesAnExplicitBudget('claude-opus-4-7')).toBe(false)
  })

  it('leaves an unknown model alone, above the 1024 minimum', () => {
    expect(clampAnthropicThinkingBudget(32768, 'claude-future-9')).toBe(32768)
    expect(clampAnthropicThinkingBudget(10, 'claude-future-9')).toBe(1024)
    expect(anthropicOutputCeiling('claude-future-9')).toBeUndefined()
  })
})
