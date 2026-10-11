import { describe, expect, it } from 'vitest'
import {
  SEED_MAX_DECISIONS_CHARS,
  SEED_MAX_HANDOFFS_CHARS,
  SEED_MIN_HANDOFF_CHARS,
  buildTaskSeed,
  truncateWithMarker,
} from '../campaignSeed'
import type { CampaignTask } from '../campaignModel'

const task = {
  id: 'a',
  title: 'A',
  brief: 'do a',
  acceptance: [],
  paths: [],
  dependsOn: [],
  status: 'queued',
  attempt: 0,
  tokensUsed: 0,
  detail: '',
} as CampaignTask

describe('seed size caps', () => {
  it('marks what a cut left out, keeping the start or the end', () => {
    expect(truncateWithMarker('abc', 10)).toBe('abc')
    expect(truncateWithMarker('0123456789', 4)).toBe(
      '0123\n[... 6 characters left out ...]'
    )
    expect(truncateWithMarker('0123456789', 4, 'end')).toBe(
      '[... 6 characters left out ...]\n6789'
    )
  })

  it('bounds decisions and the total of upstream handoffs', () => {
    const handoffs = Array.from({ length: 12 }, (_, i) => ({
      taskId: `t${i}`,
      text: 'h'.repeat(12_000),
    }))
    const seed = buildTaskSeed({
      campaign: { title: 'C', integrationBranch: 'flint/c' },
      task,
      branch: 'flint/a',
      context: { decisions: 'd'.repeat(16_000), handoffs },
    })
    const cap =
      SEED_MAX_DECISIONS_CHARS +
      Math.max(SEED_MIN_HANDOFF_CHARS, SEED_MAX_HANDOFFS_CHARS / 12) * 12
    // The brief and fencing are small; the rest is bounded by the named caps.
    expect(seed.length).toBeLessThan(cap + 6_000)
    expect(seed).toContain('characters left out')
    expect(seed).toContain('<campaign-decisions>')
  })

  it('leaves a small context untouched', () => {
    const seed = buildTaskSeed({
      campaign: { title: 'C', integrationBranch: 'flint/c' },
      task,
      branch: null,
      context: {
        decisions: 'use snake_case',
        handoffs: [{ taskId: 'b', text: 'did b' }],
      },
    })
    expect(seed).toContain('use snake_case')
    expect(seed).toContain('did b')
    expect(seed).not.toContain('left out')
  })
})
