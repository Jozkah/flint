import { describe, expect, it } from 'vitest'
import { mosaicPosition, refineStatusFor, REFINE_LEVELS } from '../refine-frame'

describe('mosaicPosition', () => {
  it('starts on the coarsest level and ends on the sharpest', () => {
    expect(mosaicPosition(0)).toEqual({ level: 0, frac: 0 })
    expect(mosaicPosition(1)).toEqual({
      level: REFINE_LEVELS.length - 1,
      frac: 0,
    })
  })
  it('moves continuously between levels', () => {
    const n = REFINE_LEVELS.length - 1
    const pos = mosaicPosition(2.5 / n)
    expect(pos.level).toBe(2)
    expect(pos.frac).toBeCloseTo(0.5)
  })
  it('clamps junk', () => {
    expect(mosaicPosition(-3).level).toBe(0)
    expect(mosaicPosition(9).level).toBe(REFINE_LEVELS.length - 1)
    expect(mosaicPosition(Number.NaN).level).toBe(0)
  })
})

describe('refineStatusFor', () => {
  it('maps job state', () => {
    expect(refineStatusFor(null)).toBe('complete')
    expect(refineStatusFor({ phase: 'queued', fraction: 0 })).toBe('queued')
    expect(
      refineStatusFor({ phase: 'sampling', fraction: 0.2, remote: 'X' })
    ).toBe('queued')
    expect(refineStatusFor({ phase: 'sampling', fraction: 0.4 })).toBe(
      'generating'
    )
    expect(refineStatusFor({ phase: 'decoding', fraction: 0.5 })).toBe(
      'refining'
    )
    expect(refineStatusFor({ phase: 'sampling', fraction: 0.9 })).toBe(
      'refining'
    )
  })
})
