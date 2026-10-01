/**
 * Splits a stream of 16 kHz mono audio into spoken phrases.
 *
 * An energy detector, not a neural one: it measures the loudness of each 20 ms
 * frame against a noise floor that follows the room, and cuts a phrase when the
 * speaker has paused. That is enough to chop a dictation into pieces a speech
 * model can take one at a time, and it needs no model download of its own.
 *
 * Pure and synchronous on purpose, so the timing rules can be tested with
 * generated audio.
 */

export const SAMPLE_RATE = 16_000
const FRAME_MS = 20
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000

export const VAD_DEFAULTS = {
  /** Speech this long in a row opens a phrase. */
  minSpeechMs: 200,
  /** This much quiet after speech closes it. */
  hangoverMs: 700,
  /** A phrase with less speech than this is a click or a cough and is dropped. */
  minPhraseSpeechMs: 400,
  /** A phrase is cut at this length even if the speaker has not paused. */
  maxPhraseMs: 15_000,
  /** Audio kept from before speech was recognised, so the first word is whole. */
  prerollMs: 300,
  /** Frames at the start used to learn how loud the room is. */
  calibrateMs: 300,
  /** Speech must be this much above the noise floor, in dB. */
  marginDb: 9,
  /** ...and never quieter than this, in dBFS, however quiet the room. */
  absoluteFloorDb: -45,
  /** How fast the noise floor may rise, in dB per second. It falls at once. */
  floorRiseDbPerSecond: 0.5,
} as const

type VadConfig = { [K in keyof typeof VAD_DEFAULTS]: number }
export type VadOptions = Partial<VadConfig>

/** Loudness of a frame in dBFS (0 is full scale), floored at -100. */
export function frameDb(frame: Float32Array): number {
  if (frame.length === 0) return -100
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  const rms = Math.sqrt(sum / frame.length)
  return rms > 1e-5 ? 20 * Math.log10(rms) : -100
}

const frames = (ms: number) => Math.max(1, Math.round(ms / FRAME_MS))

export class EnergyVad {
  private readonly o: VadConfig
  private pending = new Float32Array(0)
  private floorDb = -100
  private calibrated = 0
  private calibrationSum = 0
  private readonly preroll: Float32Array[] = []
  private open: Float32Array[] | null = null
  private speechRun: Float32Array[] = []
  private silenceRun = 0
  private speechFrames = 0

  constructor(options: VadOptions = {}) {
    this.o = { ...VAD_DEFAULTS, ...options }
  }

  /** The loudness a frame must exceed to count as speech right now. */
  get thresholdDb(): number {
    return Math.max(this.floorDb + this.o.marginDb, this.o.absoluteFloorDb)
  }

  /** Feed audio; get back every phrase that finished inside it. */
  push(samples: Float32Array): Float32Array[] {
    const joined = new Float32Array(this.pending.length + samples.length)
    joined.set(this.pending, 0)
    joined.set(samples, this.pending.length)
    const out: Float32Array[] = []
    let offset = 0
    while (joined.length - offset >= FRAME_SAMPLES) {
      const done = this.frame(joined.slice(offset, offset + FRAME_SAMPLES))
      if (done) out.push(done)
      offset += FRAME_SAMPLES
    }
    this.pending = joined.slice(offset)
    return out
  }

  /** The recording ended: hand back a phrase still in progress, if it was one. */
  flush(): Float32Array | null {
    if (!this.open) return null
    const phrase = this.close()
    this.reset()
    return phrase
  }

  private reset(): void {
    this.open = null
    this.speechRun = []
    this.silenceRun = 0
    this.speechFrames = 0
    this.preroll.length = 0
  }

  private frame(frame: Float32Array): Float32Array | null {
    const db = frameDb(frame)

    if (this.calibrated < frames(this.o.calibrateMs)) {
      this.calibrationSum += db
      this.calibrated += 1
      this.floorDb = this.calibrationSum / this.calibrated
      this.remember(frame)
      return null
    }

    const speech = db > this.thresholdDb
    // The floor follows the room down at once and up slowly, and only while
    // nobody is speaking, so a long phrase cannot raise it over itself.
    if (db < this.floorDb) {
      this.floorDb = db
    } else if (!speech && !this.open) {
      this.floorDb += (this.o.floorRiseDbPerSecond * FRAME_MS) / 1000
    }

    if (!this.open) {
      this.remember(frame)
      this.speechRun = speech ? [...this.speechRun, frame] : []
      if (this.speechRun.length >= frames(this.o.minSpeechMs)) {
        // Everything heard recently, not only the frames that were loud enough.
        this.open = this.preroll.slice()
        this.speechFrames = this.speechRun.length
        this.silenceRun = 0
        this.speechRun = []
      }
      return null
    }

    this.open.push(frame)
    if (speech) {
      this.speechFrames += 1
      this.silenceRun = 0
    } else {
      this.silenceRun += 1
    }

    if (this.silenceRun >= frames(this.o.hangoverMs)) {
      const phrase = this.close()
      this.reset()
      return phrase
    }
    if (this.open.length * FRAME_MS >= this.o.maxPhraseMs) {
      const phrase = this.close()
      // Carry the tail into the next phrase so no word is cut in half.
      const tail = this.open.slice(-frames(this.o.prerollMs))
      this.open = tail
      this.speechFrames = 0
      this.silenceRun = 0
      return phrase
    }
    return null
  }

  private remember(frame: Float32Array): void {
    this.preroll.push(frame)
    while (this.preroll.length > frames(this.o.prerollMs)) this.preroll.shift()
  }

  private close(): Float32Array | null {
    const open = this.open
    if (!open) return null
    if (this.speechFrames * FRAME_MS < this.o.minPhraseSpeechMs) return null
    const out = new Float32Array(open.length * FRAME_SAMPLES)
    open.forEach((f, i) => out.set(f, i * FRAME_SAMPLES))
    return out
  }
}
