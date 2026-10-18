import { describe, expect, it } from 'vitest'
import { assertEstimatedContextFits, cappedContextWindow, ContextEstimate } from '../contextEstimate'

describe('context cap and calibration', () => {
  it('keeps the chosen 200k cap under a 240k runtime window', () => {
    expect(cappedContextWindow(200_000, 240_000)).toBe(200_000)
    expect(cappedContextWindow(200_000, 128_000)).toBe(128_000)
    expect(cappedContextWindow(undefined, 240_000)).toBe(240_000)
    expect(cappedContextWindow(NaN, Infinity)).toBeUndefined()
  })

  it('learns when an estimated 160k prompt actually used 240k tokens', () => {
    const counter = new ContextEstimate()
    counter.observe('model', 160_000, 240_000)
    // Bounded: no tokenizer is counted as more than 1.6x the heuristic.
    expect(counter.ratio('model')).toBeCloseTo(1.6)
    expect(Math.floor(200_000 / counter.ratio('model'))).toBeLessThan(126_000)
    // Other models do not inherit this tokenizer's ratio.
    expect(counter.ratio('other')).toBe(1)
    // One low count does not undo a high one at once: the median of the recent ones decides.
    counter.observe('model', 160_000, 80_000)
    expect(counter.ratio('model')).toBeGreaterThanOrEqual(1)
  })

  it('recovers from one outlier instead of keeping the all-time maximum', () => {
    const counter = new ContextEstimate()
    counter.observe('model', 1000, 5000)
    expect(counter.ratio('model')).toBeCloseTo(1.6)
    for (let i = 0; i < 4; i++) counter.observe('model', 1000, 1000)
    expect(counter.ratio('model')).toBeLessThanOrEqual(1.1)
  })

  it('never drops below 1 however low the server counts', () => {
    const counter = new ContextEstimate()
    for (let i = 0; i < 5; i++) counter.observe('model', 1000, 100)
    expect(counter.ratio('model')).toBe(1)
  })

  it('ignores missing and invalid usage', () => {
    const counter = new ContextEstimate()
    counter.observe('model', 0, 240_000)
    counter.observe('model', 100, undefined)
    counter.observe('model', 100, NaN)
    expect(counter.ratio('model')).toBe(1)
  })

  it('refuses an oversized newest message even when the trimmer preserves it', () => {
    expect(() => assertEstimatedContextFits(240_000, 1, 200_000, 22_000)).toThrow('exceeds the available context size')
    expect(() => assertEstimatedContextFits(160_000, 1.5, 200_000, 22_000)).toThrow()
    expect(() => assertEstimatedContextFits(160_000, 1, 200_000, 22_000)).not.toThrow()
    expect(() => assertEstimatedContextFits(240_000, 1, 0, 22_000)).not.toThrow()
  })

  it('names the window and its source in the pre-flight error', () => {
    expect(() => assertEstimatedContextFits(24_000, 1, 8_192, 2_048, 'model-settings')).toThrow(
      /24000 prompt tokens plus 2048 reserved.*window of 8192 \(from model-settings\)/
    )
  })
})
