import { describe, expect, it } from 'vitest'
import { createDecodeClock, generationSpeed, speedStats } from '../tokenSpeed'

/** Feed a clock the arrival times (ms) of output pieces, one step. */
function stepOf(...times: number[]) {
  const clock = createDecodeClock()
  for (const t of times) clock.tick(4, t)
  clock.endStep()
  return clock
}

describe('createDecodeClock', () => {
  it('spans first to last piece and counts characters', () => {
    const clock = stepOf(1000, 1500, 3000)
    expect(clock.result()).toEqual({ decodeMs: 2000, steps: 1, chars: 12 })
  })

  it('adds up steps and leaves the gap between them (tools running) out', () => {
    const clock = createDecodeClock()
    clock.tick(0, 1000)
    clock.tick(0, 2000)
    clock.endStep()
    // A tool runs for ten seconds; the next step starts after it.
    clock.tick(0, 12_000)
    clock.tick(0, 13_000)
    clock.endStep()
    expect(clock.result()).toMatchObject({ decodeMs: 2000, steps: 2 })
  })

  it('gives a step that arrived in one piece no span', () => {
    expect(stepOf(5000).result()).toMatchObject({ decodeMs: 0, steps: 0 })
  })

  it('resets', () => {
    const clock = stepOf(0, 100)
    clock.reset()
    expect(clock.result()).toEqual({ decodeMs: 0, steps: 0, chars: 0 })
  })
})

describe('generationSpeed', () => {
  it("takes llama.cpp's own timings (predicted_per_second) over any clock", () => {
    // timings: { predicted_n: 97, predicted_ms: 1665.7, predicted_per_second: 58.23 }
    const got = generationSpeed({
      serverTokensPerSecond: 58.23,
      outputTokens: 97,
      decodeMs: 500,
      steps: 1,
    })
    expect(got).toMatchObject({ tokenSpeed: 58.23, tokenCount: 97, source: 'server' })
    expect(got!.durationMs).toBeCloseTo(1666, -1)
  })

  it('divides the provider usage by the decode time, not by the whole request', () => {
    // vLLM, measured: 300 completion tokens, first to last piece 2020 ms
    // (the request as a whole took 2412 ms, 392 of them before the first token).
    const got = generationSpeed({ outputTokens: 300, decodeMs: 2020, steps: 1 })
    expect(got!.source).toBe('measured')
    expect(got!.tokenSpeed).toBeCloseTo(148.0, 0)
    expect(got!.durationMs).toBe(2020)
  })

  it('does not credit the first piece of each step, which arrives already generated', () => {
    const one = generationSpeed({ outputTokens: 101, decodeMs: 1000, steps: 1 })!
    expect(one.tokenSpeed).toBeCloseTo(100, 5)
    const two = generationSpeed({ outputTokens: 102, decodeMs: 1000, steps: 2 })!
    expect(two.tokenSpeed).toBeCloseTo(100, 5)
  })

  it('estimates the count from the text when the provider reported none', () => {
    const got = generationSpeed({ outputTokens: undefined, chars: 4000, decodeMs: 10_000, steps: 1 })
    expect(got).toMatchObject({ tokenCount: 1000, source: 'estimated' })
    expect(got!.tokenSpeed).toBeCloseTo(99.9, 1)
  })

  it('says nothing when there is nothing to divide by', () => {
    expect(generationSpeed({ outputTokens: 50, decodeMs: 0 })).toBeNull()
    expect(generationSpeed({ outputTokens: 0, chars: 0, decodeMs: 1000 })).toBeNull()
    expect(generationSpeed({ outputTokens: 1, decodeMs: 1000, steps: 1 })).toBeNull()
  })

  it('ignores a server figure that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, null, undefined]) {
      expect(
        generationSpeed({ serverTokensPerSecond: bad, outputTokens: 101, decodeMs: 1000 })!.source
      ).toBe('measured')
    }
  })

  it('does not turn reasoning that was outside the text span into a huge figure', () => {
    // The Cowork bug: 37 visible tokens' worth of span, but 1500 completion
    // tokens (reasoning included). With the span covering all output the
    // figure is the model's real pace.
    const got = generationSpeed({ outputTokens: 1500, decodeMs: 10_000, steps: 1 })!
    expect(got.tokenSpeed).toBeLessThan(200)
  })
})

describe('speedStats', () => {
  it('is empty with no samples, and one sample is both latest and average', () => {
    expect(speedStats([])).toEqual({})
    const one = speedStats([{ tokenSpeed: 40, tokenCount: 200, durationMs: 5000, source: 'measured' }])
    expect(one).toEqual({ last: 40, average: 40, samples: 1, source: 'measured' })
  })

  it('averages every token over every second, not the speeds', () => {
    const stats = speedStats([
      { tokenSpeed: 100, tokenCount: 100, durationMs: 1000, source: 'server' },
      { tokenSpeed: 50, tokenCount: 300, durationMs: 6000, source: 'measured' },
    ])
    expect(stats.last).toBe(50)
    expect(stats.average).toBeCloseTo(400 / 7, 5)
    expect(stats.source).toBe('measured')
  })

  it('leaves out replies too short or too quick to time', () => {
    expect(
      speedStats([
        { tokenSpeed: 900, tokenCount: 3, durationMs: 4, source: 'server' },
        { tokenSpeed: 30, tokenCount: 60, durationMs: 2000, source: 'measured' },
      ])
    ).toMatchObject({ last: 30, average: 30, samples: 1 })
  })

  it('does not average in replies saved before the speed origin was recorded', () => {
    // The old clock could read 880 tok/s for a reply that thought first.
    const stats = speedStats([
      { tokenSpeed: 880, tokenCount: 5000, durationMs: 5700 },
      { tokenSpeed: 2400, tokenCount: 900, durationMs: 400 },
      { tokenSpeed: 63, tokenCount: 400, durationMs: 6300, source: 'measured' },
    ])
    expect(stats.average).toBeCloseTo(63, 5)
    expect(stats.samples).toBe(1)
    // Only legacy figures: the latest is still shown, no average is made up.
    const legacy = speedStats([{ tokenSpeed: 880, tokenCount: 5000, durationMs: 5700 }])
    expect(legacy.last).toBe(880)
    expect(legacy.average).toBeUndefined()
  })

  it('ignores NaN, zero and infinite inputs', () => {
    const stats = speedStats([
      { tokenSpeed: Number.NaN, tokenCount: 100, durationMs: 1000, source: 'server' },
      { tokenSpeed: Infinity, tokenCount: 100, durationMs: 1000, source: 'server' },
      { tokenSpeed: 50, tokenCount: Number.NaN, durationMs: 1000, source: 'server' },
      { tokenSpeed: 0, tokenCount: 100, durationMs: 1000, source: 'server' },
      { tokenSpeed: 25, tokenCount: 100, durationMs: 4000, source: 'measured' },
    ])
    expect(stats).toMatchObject({ last: 25, average: 25, samples: 1 })
  })

  it('always lies between the slowest and the fastest reply (property)', () => {
    let seed = 12345
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(rnd() * 40)
      const samples = Array.from({ length: n }, () => ({
        tokenSpeed: 1 + rnd() * 400,
        tokenCount: 8 + Math.floor(rnd() * 20000),
        durationMs: 60 + rnd() * 100000,
        source: (['server', 'measured', 'estimated'] as const)[Math.floor(rnd() * 3)],
      }))
      const { average, samples: counted } = speedStats(samples)
      const speeds = samples.map((s) => s.tokenSpeed)
      expect(counted).toBe(n)
      expect(average!).toBeGreaterThanOrEqual(Math.min(...speeds) - 1e-9)
      expect(average!).toBeLessThanOrEqual(Math.max(...speeds) + 1e-9)
    }
  })
})
