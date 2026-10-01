/**
 * Converts microphone audio to 16 kHz mono, the form a speech model takes.
 *
 * A microphone delivers 44.1 or 48 kHz, often in stereo. The channels are
 * averaged, a low-pass filter removes what 16 kHz cannot represent (without it
 * high tones fold back into the speech band), and the result is read off at the
 * new rate by linear interpolation. It is a stream: audio can arrive in chunks
 * of any size and the output is the same as if it had come in one piece.
 */

export const TARGET_RATE = 16_000
const TAPS = 63
/** Just under the new Nyquist frequency (8 kHz), leaving room for the filter's slope. */
const CUTOFF_HZ = 7_200

/** Windowed-sinc low-pass taps, unity gain at DC. */
export function lowPassTaps(inputRate: number, taps = TAPS, cutoff = CUTOFF_HZ): Float32Array {
  const out = new Float32Array(taps)
  const fc = cutoff / inputRate
  const mid = (taps - 1) / 2
  let sum = 0
  for (let i = 0; i < taps; i++) {
    const x = i - mid
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1))
    out[i] = sinc * hamming
    sum += out[i]
  }
  for (let i = 0; i < taps; i++) out[i] /= sum
  return out
}

/** Average interleaved or separate channels down to one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const length = channels[0]?.length ?? 0
  const out = new Float32Array(length)
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i] += channel[i] / channels.length
  }
  return out
}

export class Resampler {
  private readonly passthrough: boolean
  private readonly taps: Float32Array
  private readonly step: number
  /** Input kept between calls: the filter history, then what is not yet read out. */
  private buffer = new Float32Array(0)
  /** Position, in input samples, of the next output sample within `buffer`. */
  private position: number

  constructor(readonly inputRate: number) {
    this.passthrough = inputRate === TARGET_RATE
    this.taps = lowPassTaps(inputRate)
    this.step = inputRate / TARGET_RATE
    this.position = (TAPS - 1) / 2
  }

  /** Feed mono audio at the input rate; get 16 kHz audio back. */
  process(input: Float32Array): Float32Array {
    if (this.passthrough) return input
    const joined = new Float32Array(this.buffer.length + input.length)
    joined.set(this.buffer, 0)
    joined.set(input, this.buffer.length)

    const half = (TAPS - 1) / 2
    const out: number[] = []
    // The filtered value at integer index i needs samples i-half .. i+half.
    const filtered = (i: number): number => {
      let acc = 0
      for (let k = 0; k < TAPS; k++) acc += joined[i - half + k] * this.taps[k]
      return acc
    }
    let pos = this.position
    while (Math.floor(pos) + 1 + half < joined.length) {
      const i = Math.floor(pos)
      const frac = pos - i
      out.push(filtered(i) * (1 - frac) + filtered(i + 1) * frac)
      pos += this.step
    }
    // Keep enough history for the next filter window.
    const keepFrom = Math.max(0, Math.floor(pos) - half)
    this.buffer = joined.slice(keepFrom)
    this.position = pos - keepFrom
    return Float32Array.from(out)
  }
}
