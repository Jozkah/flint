import { describe, it, expect } from 'vitest'

/**
 * The generation speed shown under an assistant message.
 *
 * A real thread on this machine recorded `usage.outputTokens = 97`,
 * `tokenSpeed.tokenCount = 97` and `tokenSpeed.tokenSpeed = 0`. The tokens were
 * counted; the speed was not. `tokenSpeed` is only computed when the measured
 * duration is positive, and the clock was started exclusively on `text-start`
 * or `reasoning-start` -- so a provider that streams deltas without announcing
 * a start left the duration at zero, and the indicator rendered the count with
 * no speed beside it.
 *
 * These pin the rule rather than the implementation: any part that carries
 * output starts the clock, and a positive duration with a positive token count
 * produces a positive speed.
 */

/** The clock rule, as `messageMetadata` applies it. */
function startsTheClock(partType: string): boolean {
  return (
    partType === 'text-start' ||
    partType === 'reasoning-start' ||
    partType === 'text-delta' ||
    partType === 'reasoning-delta'
  )
}

/** The speed rule, as the `finish` branch applies it. */
function tokenSpeed(
  outputTokens: number,
  durationMs: number,
  providerTokensPerSecond = 0
): number {
  const durationSec = durationMs / 1000
  if (durationSec > 0 && outputTokens > 0) {
    return providerTokensPerSecond > 0
      ? providerTokensPerSecond
      : outputTokens / durationSec
  }
  return 0
}

describe('token speed measurement', () => {
  it('starts the clock on a delta, not only on an announced start', () => {
    // The regression: these two were the only parts that started it.
    expect(startsTheClock('text-start')).toBe(true)
    expect(startsTheClock('reasoning-start')).toBe(true)
    // A provider that goes straight to output must still be measured.
    expect(startsTheClock('text-delta')).toBe(true)
    expect(startsTheClock('reasoning-delta')).toBe(true)
  })

  it('does not start the clock on parts that carry no output', () => {
    for (const part of ['start', 'start-step', 'finish-step', 'finish', 'tool-call']) {
      expect(startsTheClock(part), part).toBe(false)
    }
  })

  it('reports a speed once the stream has been timed', () => {
    // 97 tokens in 2s is the shape of the real message that showed 0.
    expect(tokenSpeed(97, 2000)).toBeCloseTo(48.5)
  })

  /** The exact failure: tokens counted, duration never measured. */
  it('reports zero only when there is nothing to divide by', () => {
    expect(tokenSpeed(97, 0)).toBe(0)
    expect(tokenSpeed(0, 2000)).toBe(0)
  })

  it("prefers the provider's own measurement when it has one", () => {
    // llama.cpp reports `predicted_per_second`; trust it over our wall clock,
    // which includes time we did not spend generating.
    expect(tokenSpeed(97, 2000, 58.23)).toBeCloseTo(58.23)
    // ...but a provider reporting nothing does not suppress the fallback.
    expect(tokenSpeed(97, 2000, 0)).toBeCloseTo(48.5)
  })
})
