import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_BUDGET,
  messageWeight,
  transcriptWindowStart,
} from '../transcriptWindow'

describe('messageWeight', () => {
  it('counts the message and each tool call', () => {
    expect(messageWeight([{ type: 'text' }])).toBe(1)
    expect(
      messageWeight([{ type: 'text' }, { type: 'tool-bash' }, { type: 'tool-edit' }, { type: 'reasoning' }])
    ).toBe(3)
    expect(messageWeight(undefined)).toBe(1)
  })
})

describe('transcriptWindowStart', () => {
  it('draws all of a light transcript', () => {
    expect(transcriptWindowStart([1, 1, 1], 0)).toBe(0)
    expect(transcriptWindowStart([], 0)).toBe(0)
  })

  it('stops once the budget is spent, newest first', () => {
    const weights = Array.from({ length: 100 }, () => 1)
    expect(transcriptWindowStart(weights, 0)).toBe(100 - TRANSCRIPT_BUDGET)
    expect(transcriptWindowStart(weights, 1)).toBe(0)
  })

  it('counts tool calls, so a few heavy messages fill the window', () => {
    // Six messages of 40 calls each: the newest two are always drawn, the rest
    // wait, and each press adds another budget.
    const weights = Array.from({ length: 6 }, () => 41)
    expect(transcriptWindowStart(weights, 0)).toBe(4)
    expect(transcriptWindowStart(weights, 2)).toBe(2)
  })

  it('always draws the newest messages, however heavy', () => {
    expect(transcriptWindowStart([500, 500, 500], 0)).toBe(1)
  })
})
