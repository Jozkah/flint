import { describe, expect, it } from 'vitest'
import {
  describeRunEnd,
  isRunEndReason,
  runEndNeedsAttention,
} from '../runEnded'

describe('run endings', () => {
  it('says the same thing for every reason the loop can send', () => {
    const reasons = [
      'completed',
      'user_stop',
      'budget',
      'turn_limit',
      'refusal',
      'error',
      'lease_lost',
    ]
    const sentences = reasons.map((reason) =>
      describeRunEnd({ reason, label: '' })
    )
    expect(new Set(sentences).size).toBe(reasons.length)
    expect(sentences.every((s) => s.length > 0)).toBe(true)
  })

  it('prefers the label the loop sent', () => {
    expect(describeRunEnd({ reason: 'budget', label: 'Over budget.' })).toBe(
      'Over budget.'
    )
  })

  it('falls back to the generic failure for a reason it has not heard of', () => {
    expect(describeRunEnd({ reason: 'new_reason', label: '' })).toBe(
      describeRunEnd({ reason: 'error', label: '' })
    )
    expect(isRunEndReason('new_reason')).toBe(false)
    expect(isRunEndReason('lease_lost')).toBe(true)
  })

  it('treats only a plain finish as needing no attention', () => {
    expect(runEndNeedsAttention('completed')).toBe(false)
    expect(runEndNeedsAttention('turn_limit')).toBe(true)
  })
})
