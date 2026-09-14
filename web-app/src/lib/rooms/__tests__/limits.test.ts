import { describe, it, expect } from 'vitest'
import {
  HARD_CALL_CEILING,
  addCallUsage,
  checkLimits,
  clampLimits,
  costIsEnforceable,
  emptyUsage,
  measureCall,
} from '../limits'
import { ROOM_LIMIT_CEILINGS } from '../types'
import { makeRoom, participant } from './helpers'

describe('clampLimits', () => {
  it('clamps absurd values to the code ceilings', () => {
    const l = clampLimits({
      maxRounds: 1e9,
      maxTurns: Infinity,
      maxConsecutivePerParticipant: -5,
      maxTotalTokens: Number.NaN,
      maxOutputTokensPerTurn: 1e12,
      maxCostUsd: -1,
      maxDurationMs: 1e15,
      maxRepetitiveTurns: 1e6,
      repetitionSimilarity: 7,
    })
    expect(l.maxRounds).toBe(ROOM_LIMIT_CEILINGS.maxRounds)
    expect(l.maxTurns).toBeLessThanOrEqual(ROOM_LIMIT_CEILINGS.maxTurns)
    expect(l.maxConsecutivePerParticipant).toBe(1)
    expect(l.maxTotalTokens).toBeLessThanOrEqual(ROOM_LIMIT_CEILINGS.maxTotalTokens)
    expect(l.maxOutputTokensPerTurn).toBe(ROOM_LIMIT_CEILINGS.maxOutputTokensPerTurn)
    expect(l.maxCostUsd).toBeNull()
    expect(l.maxDurationMs).toBe(ROOM_LIMIT_CEILINGS.maxDurationMs)
    expect(l.maxRepetitiveTurns).toBe(ROOM_LIMIT_CEILINGS.maxRepetitiveTurns)
    expect(l.repetitionSimilarity).toBe(1)
  })

  it('Infinity clamps to the ceiling; null (JSON of Infinity) uses the default', () => {
    expect(clampLimits({ maxTotalTokens: Number.POSITIVE_INFINITY }).maxTotalTokens).toBe(ROOM_LIMIT_CEILINGS.maxTotalTokens)
    expect(clampLimits({ maxTotalTokens: null as unknown as number }).maxTotalTokens).toBe(200_000)
  })

  it('hard call ceiling is maxTurns ceiling plus half', () => {
    expect(HARD_CALL_CEILING).toBe(300)
  })
})

describe('checkLimits', () => {
  const at = (usage: Partial<ReturnType<typeof emptyUsage>>, limits = {}) =>
    makeRoom({ usage: { ...emptyUsage(), ...usage }, limits })

  it('returns null inside all limits', () => {
    expect(checkLimits(at({}), 0)).toBeNull()
  })
  it('reports turns, rounds, tokens, time and ceiling', () => {
    expect(checkLimits(at({ turns: 5 }, { maxTurns: 5 }), 0)).toBe('maxTurns')
    expect(checkLimits(at({ rounds: 2 }, { maxRounds: 2 }), 0)).toBe('maxRounds')
    expect(checkLimits(at({ inputTokens: 60, outputTokens: 40 }, { maxTotalTokens: 100 }), 0)).toBe(
      'maxTotalTokens'
    )
    expect(checkLimits(at({ activeMs: 500 }, { maxDurationMs: 1000 }), 1600, { activeSince: 1000 })).toBe(
      'maxDurationMs'
    )
    expect(checkLimits(at({}), 0, { callsMade: HARD_CALL_CEILING })).toBe('ceiling')
  })
  it('skips turn and round limits for closing work', () => {
    expect(checkLimits(at({ turns: 5 }, { maxTurns: 5 }), 0, { speaking: false })).toBeNull()
  })
  it('enforces cost only when every speaking model has pricing', () => {
    const pricing = { inputPerMTokUsd: 1, outputPerMTokUsd: 1 }
    const priced = makeRoom({
      participants: [
        participant('a', 'A', 'provider-a', 'model-1', { pricing }),
        participant('b', 'B', 'provider-b', 'model-2', { pricing }),
      ],
      usage: { ...emptyUsage(), costUsd: 2 },
      limits: { maxCostUsd: 1 },
    })
    expect(costIsEnforceable(priced)).toBe(true)
    expect(checkLimits(priced, 0)).toBe('maxCostUsd')
    const unpriced = { ...priced, participants: [priced.participants[0], { ...priced.participants[1], pricing: undefined }] }
    expect(costIsEnforceable(unpriced)).toBe(false)
    expect(checkLimits(unpriced, 0)).toBeNull()
  })
})

describe('usage accounting', () => {
  it('uses provider usage when present', () => {
    expect(
      measureCall({ providerUsage: { inputTokens: 10, outputTokens: 5 }, promptText: 'x', replyText: 'y' })
    ).toEqual({ inputTokens: 10, outputTokens: 5, estimated: false })
  })
  it('estimates and flags when usage is missing', () => {
    const u = measureCall({ promptText: 'a'.repeat(35), replyText: 'b'.repeat(7) })
    expect(u).toEqual({ inputTokens: 10, outputTokens: 2, estimated: true })
  })
  it('adds cost only with pricing and never invents it', () => {
    const priced = addCallUsage(emptyUsage(), { inputTokens: 1_000_000, outputTokens: 500_000, estimated: false }, {
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 4,
    })
    expect(priced.costUsd).toBe(4)
    const unpriced = addCallUsage(priced, { inputTokens: 1, outputTokens: 1, estimated: true }, undefined)
    expect(unpriced.costUsd).toBeNull()
    expect(unpriced.estimated).toBe(true)
    const later = addCallUsage(unpriced, { inputTokens: 1, outputTokens: 1, estimated: false }, {
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 1,
    })
    expect(later.costUsd).toBeNull()
  })
})
