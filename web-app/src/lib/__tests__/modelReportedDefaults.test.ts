import { describe, expect, it } from 'vitest'
import { formatReported, reportedDefaults } from '../modelReportedDefaults'

describe('reportedDefaults', () => {
  it('keeps the sampling values the server names, and maps the output cap', () => {
    expect(
      reportedDefaults({
        temperature: 0.8,
        top_k: 40,
        top_p: 0.95,
        n_predict: 4096,
        seed: 42,
        stream: true,
      })
    ).toEqual({ temperature: 0.8, top_k: 40, top_p: 0.95, max_output_tokens: 4096 })
  })

  it('shows no output cap when the server runs until the context is full', () => {
    expect(reportedDefaults({ n_predict: -1 })).toEqual({})
  })

  it('is empty when nothing is reported', () => {
    expect(reportedDefaults(undefined)).toEqual({})
    expect(reportedDefaults({})).toEqual({})
  })
})

describe('formatReported', () => {
  it('reads as short text', () => {
    expect(formatReported(0.8)).toBe('0.8')
    expect(formatReported(40)).toBe('40')
    expect(formatReported(0.30000000000000004)).toBe('0.3')
    expect(formatReported(false)).toBe('off')
    expect(formatReported(['top_k', 'top_p'])).toBe('top_k, top_p')
  })
})
