import { describe, expect, it, vi } from 'vitest'
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

describe('describeRunEnd localisation', () => {
  it('reads the sentence from the locale file for the active language', async () => {
    const { i18n } = await import('@/i18n/react-i18next-compat')
    const spy = vi.spyOn(i18n, 't').mockImplementation(((key: string) => `de:${key}`) as never)
    try {
      expect(describeRunEnd({ reason: 'user_stop', label: '' })).toBe('de:tools:runEnd.userStop')
      // An unknown tag still lands on the generic failure sentence.
      expect(describeRunEnd({ reason: 'weird', label: '' })).toBe('de:tools:runEnd.error')
      // The loop's own label always wins.
      expect(describeRunEnd({ reason: 'user_stop', label: 'Custom.' })).toBe('Custom.')
    } finally {
      spy.mockRestore()
    }
  })
})
