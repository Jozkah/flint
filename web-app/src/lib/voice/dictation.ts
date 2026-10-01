import { EnergyVad, SAMPLE_RATE } from '@/lib/voice/vad'
import { Resampler } from '@/lib/voice/resample'
import { encodeWav } from '@/lib/voice/wav'
import {
  cleanTranscript,
  isPlausibleTranscript,
} from '@/lib/voice/transcript'
import { appendSegment } from '@/lib/voice/promptMerge'
import type { Recorder } from '@/lib/voice/recorder'

/**
 * One dictation: from pressing the microphone to pressing it again.
 *
 * Audio is cut into phrases while the person is still talking. Each phrase goes
 * to the speech model on its own, one after another, and its words are added to
 * the transcript when they come back, so text appears phrase by phrase instead
 * of all at the end.
 */

export type DictationState = 'idle' | 'starting' | 'listening' | 'stopping'

export type DictationError =
  | { kind: 'recorder'; message: string }
  | { kind: 'model-missing'; message: string }
  | { kind: 'transcription'; message: string }

export type DictationHandlers = {
  onState?: (state: DictationState) => void
  /** Everything transcribed so far, as one string. */
  onTranscript?: (committed: string) => void
  /** How many phrases are waiting for the speech model. */
  onPending?: (count: number) => void
  onError?: (error: DictationError) => void
}

export type DictationDeps = {
  recorder: Recorder
  transcribe: (
    wav: Uint8Array,
    options: { language?: string }
  ) => Promise<string>
  language?: () => string | undefined
  isModelMissing?: (error: unknown) => boolean
}

/** Failures in a row, with no phrase between, that end the session. */
const MAX_CONSECUTIVE_FAILURES = 2
/** How long stopping waits for phrases still being transcribed. */
const DRAIN_TIMEOUT_MS = 15_000

export class DictationSession {
  private state: DictationState = 'idle'
  private committed = ''
  private vad = new EnergyVad()
  private resampler: Resampler | null = null
  private queue: Float32Array[] = []
  private working: Promise<void> | null = null
  private failures = 0
  private cancelled = false
  private ended = false

  constructor(
    private readonly deps: DictationDeps,
    private readonly handlers: DictationHandlers = {}
  ) {}

  get current(): DictationState {
    return this.state
  }

  get transcript(): string {
    return this.committed
  }

  private set(state: DictationState): void {
    this.state = state
    this.handlers.onState?.(state)
  }

  private fail(error: DictationError): void {
    this.handlers.onError?.(error)
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return
    this.set('starting')
    try {
      await this.deps.recorder.start((mono, rate) => this.hear(mono, rate))
    } catch (error) {
      this.set('idle')
      this.fail({
        kind: 'recorder',
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    // A stop or cancel pressed while the microphone was opening.
    if (this.cancelled || this.ended) {
      await this.deps.recorder.stop()
      this.set('idle')
      return
    }
    this.set('listening')
  }

  /** Audio from the recorder: bring it to 16 kHz and cut it into phrases. */
  private hear(mono: Float32Array, rate: number): void {
    if (this.state !== 'listening' || this.cancelled) return
    if (!this.resampler || this.resampler.inputRate !== rate) {
      this.resampler = new Resampler(rate)
    }
    const phrases = this.vad.push(this.resampler.process(mono))
    for (const phrase of phrases) this.enqueue(phrase)
  }

  private enqueue(phrase: Float32Array): void {
    this.queue.push(phrase)
    this.handlers.onPending?.(this.queue.length + (this.working ? 1 : 0))
    this.working ??= this.work().finally(() => {
      this.working = null
      this.handlers.onPending?.(this.queue.length)
    })
  }

  private async work(): Promise<void> {
    while (this.queue.length > 0 && !this.cancelled && !this.ended) {
      const phrase = this.queue.shift() as Float32Array
      const seconds = phrase.length / SAMPLE_RATE
      try {
        const raw = await this.deps.transcribe(encodeWav(phrase, SAMPLE_RATE), {
          language: this.deps.language?.(),
        })
        if (this.cancelled) return
        this.failures = 0
        if (!isPlausibleTranscript(raw, seconds)) continue
        const text = cleanTranscript(raw)
        if (!text) continue
        this.committed = appendSegment(this.committed, text)
        this.handlers.onTranscript?.(this.committed)
      } catch (error) {
        if (this.cancelled) return
        if (this.deps.isModelMissing?.(error)) {
          this.fail({
            kind: 'model-missing',
            message: 'The voice model is not installed.',
          })
          this.ended = true
          void this.shutdown()
          return
        }
        this.failures += 1
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
          this.fail({
            kind: 'transcription',
            message:
              error instanceof Error ? error.message : 'Transcription failed.',
          })
          this.ended = true
          void this.shutdown()
          return
        }
      }
    }
  }

  private async shutdown(): Promise<void> {
    await this.deps.recorder.stop()
    this.queue = []
    this.set('idle')
  }

  /** Press the microphone again: finish the phrase in progress, wait for the rest. */
  async stop(): Promise<string> {
    if (this.state === 'idle') return this.committed
    if (this.state === 'starting') {
      this.ended = true
      return this.committed
    }
    this.set('stopping')
    await this.deps.recorder.stop()
    if (!this.cancelled && !this.ended) {
      const tail = this.vad.flush()
      if (tail) this.enqueue(tail)
    }
    const drained = this.working ?? Promise.resolve()
    await Promise.race([
      drained,
      new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
    ])
    this.ended = true
    this.queue = []
    this.set('idle')
    return this.committed
  }

  /** Throw the session away; whatever it transcribed is not kept by the caller. */
  async cancel(): Promise<void> {
    this.cancelled = true
    this.queue = []
    if (this.state === 'idle') return
    await this.deps.recorder.stop()
    this.set('idle')
  }
}
