import { describe, expect, it } from 'vitest'
import { TRANSCRIPT_WINDOW, transcriptWindowStart } from '../transcriptWindow'

describe('transcriptWindowStart', () => {
  it('draws everything of a short transcript', () => {
    expect(transcriptWindowStart(10, 0)).toBe(0)
    expect(transcriptWindowStart(TRANSCRIPT_WINDOW, 0)).toBe(0)
  })

  it('draws only the newest of a long one, and more on request', () => {
    expect(transcriptWindowStart(100, 0)).toBe(100 - TRANSCRIPT_WINDOW)
    expect(transcriptWindowStart(100, TRANSCRIPT_WINDOW)).toBe(100 - 2 * TRANSCRIPT_WINDOW)
    expect(transcriptWindowStart(100, 1000)).toBe(0)
  })
})
