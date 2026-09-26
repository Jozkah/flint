import { describe, it, expect } from 'vitest'
import {
  budgetExceeded,
  creditCompaction,
  newSpend,
  recordSpend,
  MAX_AGENT_STEPS,
  MAX_SUBAGENT_STEPS,
  MAX_SESSION_TOKENS,
} from '../coworkBudget'

describe('budgetExceeded', () => {
  it('is null while under both caps', () => {
    expect(budgetExceeded({ step: 0, sessionTokens: 0 })).toBeNull()
    expect(
      budgetExceeded({ step: MAX_AGENT_STEPS - 1, sessionTokens: 0 })
    ).toBeNull()
  })

  it('reports the step cap at the boundary, not past it', () => {
    expect(budgetExceeded({ step: MAX_AGENT_STEPS, sessionTokens: 0 })).toBe(
      'steps'
    )
  })

  it('reports the token cap', () => {
    expect(
      budgetExceeded({ step: 0, sessionTokens: MAX_SESSION_TOKENS })
    ).toBe('tokens')
  })

  // Steps first: it is the cheaper one to explain and the one "Keep going"
  // can actually resolve, whereas the token cap needs a compact or a new
  // session.
  it('reports steps first when both are exceeded', () => {
    expect(
      budgetExceeded({
        step: MAX_AGENT_STEPS,
        sessionTokens: MAX_SESSION_TOKENS,
      })
    ).toBe('steps')
  })

  it('honours a caller-supplied cap, as a subagent uses', () => {
    expect(
      budgetExceeded({ step: MAX_SUBAGENT_STEPS, sessionTokens: 0 }, MAX_SUBAGENT_STEPS)
    ).toBe('steps')
    expect(
      budgetExceeded({ step: MAX_SUBAGENT_STEPS - 1, sessionTokens: 0 }, MAX_SUBAGENT_STEPS)
    ).toBeNull()
  })

  it('keeps a subagent on a tighter leash than the parent', () => {
    expect(MAX_SUBAGENT_STEPS).toBeLessThan(MAX_AGENT_STEPS)
  })
})

describe('recordSpend', () => {
  // The bug this exists to prevent: every step of an agent turn replays the
  // whole conversation, so summing each step's total_tokens charges the same
  // context once per step and trips a 200k cap ten steps into a 100-step run.
  it('charges prompt growth once, not the replayed prompt every step', () => {
    let s = newSpend()
    s = recordSpend(s, {
      prompt_tokens: 10_000,
      completion_tokens: 200,
      total_tokens: 10_200,
    })
    expect(s.spent).toBe(10_200)
    // Step two replays the same 10k prompt plus the previous output.
    s = recordSpend(s, {
      prompt_tokens: 10_400,
      completion_tokens: 300,
      total_tokens: 10_700,
    })
    // 300 new output + 400 of prompt growth, not another 10,700.
    expect(s.spent).toBe(10_900)
  })

  it('never charges negative growth when the prompt shrinks after a compaction', () => {
    let s = newSpend()
    s = recordSpend(s, {
      prompt_tokens: 10_000,
      completion_tokens: 100,
      total_tokens: 10_100,
    })
    s = recordSpend(s, {
      prompt_tokens: 4_000,
      completion_tokens: 50,
      total_tokens: 4_050,
    })
    expect(s.spent).toBe(10_150)
  })

  it('falls back to the total delta when the provider omits the breakdown', () => {
    let s = newSpend()
    s = recordSpend(s, { total_tokens: 500 })
    s = recordSpend(s, { total_tokens: 900 })
    expect(s.spent).toBe(900)
  })

  it('falls back to completion tokens when there is no total', () => {
    let s = newSpend()
    s = recordSpend(s, { completion_tokens: 40 })
    s = recordSpend(s, { completion_tokens: 60 })
    expect(s.spent).toBe(100)
  })

  it('leaves the spend untouched when a step reports no usage', () => {
    const s = recordSpend(newSpend(77), null)
    expect(s.spent).toBe(77)
  })

  it('carries a starting spend', () => {
    expect(newSpend(1_000).spent).toBe(1_000)
  })
})

describe('creditCompaction', () => {
  it('makes the counted prompt the compacted prompt', () => {
    let s = newSpend()
    s = recordSpend(s, {
      prompt_tokens: 150_000,
      completion_tokens: 1_000,
      total_tokens: 151_000,
    })
    // Compaction replaced 120k of that history with a summary.
    s = creditCompaction(s, 120_000)
    expect(s.spent).toBe(31_000)
    expect(s.lastPrompt).toBe(30_000)
    // The next step is charged for its growth past the compacted prompt only.
    s = recordSpend(s, {
      prompt_tokens: 32_000,
      completion_tokens: 500,
      total_tokens: 32_500,
    })
    expect(s.spent).toBe(31_000 + 500 + 2_000)
  })

  it('never credits more than the prompt it counted', () => {
    let s = newSpend(50_000)
    s = recordSpend(s, {
      prompt_tokens: 1_000,
      completion_tokens: 100,
      total_tokens: 1_100,
    })
    s = creditCompaction(s, 5_000)
    expect(s.lastPrompt).toBe(0)
    expect(s.spent).toBe(50_000 + 100)
  })

  it('leaves the spend alone before the first step or with nothing saved', () => {
    const fresh = newSpend(10_000)
    expect(creditCompaction(fresh, 3_000)).toBe(fresh)
    const s = recordSpend(newSpend(), {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    })
    expect(creditCompaction(s, 0)).toBe(s)
  })
})
