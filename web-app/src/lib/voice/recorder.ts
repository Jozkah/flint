import { downmix } from '@/lib/voice/resample'

/**
 * Microphone capture in the web view.
 *
 * Audio arrives as chunks of mono floats at whatever rate the device runs at.
 * An AudioWorklet delivers them off the main thread where it is available, and a
 * ScriptProcessor is the fallback for a web view without one.
 */

export type AudioChunk = (mono: Float32Array, sampleRate: number) => void

export type Recorder = {
  start(onChunk: AudioChunk): Promise<void>
  stop(): Promise<void>
  /** Loudness of the last chunk, 0..1, for a level meter. */
  readonly level: number
}

export type RecorderErrorCode = 'denied' | 'no-device' | 'unsupported' | 'failed'

export class RecorderError extends Error {
  constructor(
    readonly code: RecorderErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RecorderError'
  }
}

/** Map what `getUserMedia` throws to a reason the user can act on. */
export function recorderErrorFrom(error: unknown): RecorderError {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecorderError(
      'denied',
      'Microphone access was refused. Allow it in your system settings and try again.'
    )
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new RecorderError('no-device', 'No microphone was found.')
  }
  return new RecorderError(
    'failed',
    `The microphone could not be opened${
      error instanceof Error && error.message ? `: ${error.message}` : '.'
    }`
  )
}

/** Served from `public/`: a blob URL would be refused by the content security policy. */
const WORKLET_URL = '/voice-capture-worklet.js'

export function createBrowserRecorder(): Recorder {
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let node: AudioNode | null = null
  let level = 0

  const report = (onChunk: AudioChunk, channels: Float32Array[], rate: number) => {
    const mono = downmix(channels)
    let peak = 0
    for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]))
    level = peak
    onChunk(mono, rate)
  }

  return {
    get level() {
      return level
    },

    async start(onChunk) {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof AudioContext === 'undefined'
      ) {
        throw new RecorderError(
          'unsupported',
          'This window cannot record audio.'
        )
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
      } catch (error) {
        throw recorderErrorFrom(error)
      }
      try {
        context = new AudioContext()
        const source = context.createMediaStreamSource(stream)
        const rate = context.sampleRate
        let worklet: AudioWorkletNode | null = null
        if (context.audioWorklet) {
          try {
            await context.audioWorklet.addModule(WORKLET_URL)
            worklet = new AudioWorkletNode(context, 'flint-capture')
          } catch {
            // No worklet in this web view: the script processor below does the job.
            worklet = null
          }
        }
        if (worklet) {
          worklet.port.onmessage = (event: MessageEvent<Float32Array[]>) =>
            report(onChunk, event.data, rate)
          source.connect(worklet)
          node = worklet
        } else {
          const processor = context.createScriptProcessor(4096, 1, 1)
          processor.onaudioprocess = (event) =>
            report(onChunk, [event.inputBuffer.getChannelData(0).slice()], rate)
          source.connect(processor)
          // A script processor only runs when connected onward.
          processor.connect(context.destination)
          node = processor
        }
        await context.resume()
      } catch (error) {
        await this.stop()
        throw recorderErrorFrom(error)
      }
    },

    async stop() {
      level = 0
      try {
        node?.disconnect()
      } catch {
        // Already disconnected.
      }
      node = null
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
      if (context && context.state !== 'closed') {
        await context.close().catch(() => undefined)
      }
      context = null
    },
  }
}
