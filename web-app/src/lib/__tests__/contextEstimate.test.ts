import { describe, expect, it } from 'vitest'
import {
  assertEstimatedContextFits,
  cappedContextWindow,
  ContextEstimate,
  estimateCountsEveryPart,
  PREFLIGHT_CONTEXT_ERROR_PREFIX,
} from '../contextEstimate'

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
      /24,000 prompt tokens plus 2,048 reserved.*window of 8,192 \(from model-settings\)/
    )
  })

  // The reported banner: 130,716 heuristic tokens x1.6 = 209,145 plus a 22,000
  // reserve against a configured 200,000 window.
  const reported = {
    systemPrompt: 9_000,
    tools: 120_000,
    toolCount: 240,
    history: 1_700,
    latest: 16,
  }
  const reportedEstimate = 130_716

  it('prints the window once, exactly, with no 1024-based label beside it', () => {
    let message = ''
    try {
      assertEstimatedContextFits(reportedEstimate, 1.6, 200_000, 22_000, { source: 'configured' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('against a window of 200,000 (from configured)')
    expect(message).not.toContain('195K')
    expect(message).not.toContain('226K')
  })

  it('breaks the estimate down by part and points at the largest one', () => {
    expect(() =>
      assertEstimatedContextFits(reportedEstimate, 1.6, 200_000, 22_000, {
        source: 'configured',
        breakdown: reported,
      })
    ).toThrow(
      /system prompt 14,400, tool definitions \(240 tools\) 192,000, earlier conversation 2,720, latest message 26\. This includes a x1\.60 correction learned from this model's reported usage \(130,716 before it\)\./
    )
  })

  it('names the largest part within the 300 characters a Cowork run card shows', () => {
    let message = ''
    try {
      assertEstimatedContextFits(reportedEstimate, 1.6, 200_000, 22_000, {
        source: 'configured',
        breakdown: reported,
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.slice(0, 300)).toContain(
      'Most of it is the tool definitions (240 tools): 192,000 of 209,146 prompt tokens; ' +
        'turn off MCP servers or tools this conversation does not need.'
    )
  })

  it('sends a first request that is over only by the learned calibration', () => {
    // 130,716 + 22,000 fits 200,000 on Flint's own count; only the x1.6
    // calibration puts it over. The provider decides, and a length refusal
    // goes through overflow recovery.
    expect(() =>
      assertEstimatedContextFits(reportedEstimate, 1.6, 200_000, 22_000, { strict: false })
    ).not.toThrow()
    // The resend after a refusal is still checked on the calibrated count.
    expect(() =>
      assertEstimatedContextFits(reportedEstimate, 1.6, 200_000, 22_000, { strict: true })
    ).toThrow(PREFLIGHT_CONTEXT_ERROR_PREFIX)
    // A request that cannot fit even uncalibrated is refused either way.
    expect(() =>
      assertEstimatedContextFits(190_000, 1.6, 200_000, 22_000, { strict: false })
    ).toThrow(PREFLIGHT_CONTEXT_ERROR_PREFIX)
  })

  it('does not calibrate on a request carrying parts the estimate leaves out', () => {
    const text = { parts: [{ type: 'text' }] }
    expect(estimateCountsEveryPart([text, text], 0)).toBe(true)
    expect(estimateCountsEveryPart([text, { parts: [{ type: 'text' }, { type: 'file' }] }], 0)).toBe(false)
    expect(estimateCountsEveryPart([text], 2)).toBe(false)
  })
})
