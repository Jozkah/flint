// RPC handlers for Studio and dictation. Generation and transcription run on
// the desktop; these validate what a phone sends and call `RemoteStudio` /
// `RemoteVoice`, which the app implements over useStudio and lib/voice (see
// `appStudio`) and tests implement with plain data. Media never travels as a
// path: a phone names a gallery item, and gets its bytes back as a data URL.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import type {
  StudioItemWire,
  StudioKindWire,
  StudioStatusResult,
} from './protocol'

export type StudioRequest = {
  kind: StudioKindWire
  prompt: string
  negative?: string
  sizeIndex: number
  count: number
  seconds: number
  seed?: number
  memoryAcknowledged: boolean
}

export type RemoteStudio = {
  status(): Promise<StudioStatusResult>
  load(modelId: string): Promise<void>
  unload(): Promise<void>
  download(modelId: string): Promise<void>
  /** Starts a job in the background; throws a RemoteRpcError when it cannot. */
  generate(req: StudioRequest): Promise<void>
  stop(): Promise<void>
  gallery(kind: StudioKindWire): Promise<StudioItemWire[]>
  /** The item's media as a data URL, or null when there is no such item. */
  media(kind: StudioKindWire, id: string): Promise<string | null>
  /** Same prompt and settings, a new seed. False when there is no such item. */
  remix(kind: StudioKindWire, id: string): Promise<boolean>
  remove(kind: StudioKindWire, id: string): Promise<void>
}

export type RemoteVoice = {
  ready(): boolean
  transcribe(wav: Uint8Array, language?: string): Promise<string>
}

export type StudioMethods =
  | 'studio.status'
  | 'studio.load'
  | 'studio.unload'
  | 'studio.download'
  | 'studio.generate'
  | 'studio.stop'
  | 'studio.gallery'
  | 'studio.media'
  | 'studio.remix'
  | 'studio.delete'
  | 'voice.status'
  | 'voice.transcribe'

/** Base64 of the largest WAV accepted: about two and a half minutes. Matches
 * the server's body cap for `voice.transcribe` (MAX_VOICE_BODY, 6 MiB). */
export const MAX_AUDIO_B64 = 6 * 1024 * 1024 - 1024
export const MAX_PROMPT = 4000

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

function kindOf(v: unknown): StudioKindWire {
  if (v !== 'image' && v !== 'video') throw new RemoteRpcError('bad_params', 'kind must be image or video')
  return v
}

/** Gallery ids are file-safe names the desktop made; nothing else is accepted. */
export function itemId(v: unknown): string {
  const id = str(v)
  if (!id || id.length > 200 || !/^[\w-]+$/.test(id)) throw new RemoteRpcError('bad_params', 'Not a gallery item')
  return id
}

function modelId(v: unknown): string {
  const id = str(v)
  if (!id || id.length > 200 || !/^[\w.:/-]+$/.test(id)) throw new RemoteRpcError('bad_params', 'modelId is required')
  return id
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RemoteRpcError('bad_params', `Expected a whole number from ${min} to ${max}`)
  }
  return v
}

export function parseGenerate(params: unknown): StudioRequest {
  const p = rec(params)
  const prompt = str(p.prompt)
  if (!prompt) throw new RemoteRpcError('bad_params', 'Write a prompt first')
  if (prompt.length > MAX_PROMPT) throw new RemoteRpcError('bad_params', 'The prompt is too long')
  const negative = str(p.negative).slice(0, MAX_PROMPT) || undefined
  return {
    kind: kindOf(p.kind),
    prompt,
    negative,
    sizeIndex: int(p.sizeIndex, 0, 16, 0),
    count: int(p.count, 1, 4, 1),
    seconds: int(p.seconds, 1, 10, 2),
    seed: p.seed === undefined || p.seed === null ? undefined : int(p.seed, 0, 4_294_967_295, 0),
    memoryAcknowledged: p.memoryAcknowledged === true,
  }
}

/** Decodes the WAV a phone sent, refusing anything that is not one. */
export function decodeWav(raw: unknown): Uint8Array {
  if (typeof raw !== 'string' || !raw) throw new RemoteRpcError('bad_params', 'audio is required')
  if (raw.length > MAX_AUDIO_B64) throw new RemoteRpcError('too_large', 'That recording is too long')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new RemoteRpcError('bad_params', 'audio must be base64')
  const bin = atob(raw)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4))
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new RemoteRpcError('bad_params', 'audio must be a WAV file')
  }
  return bytes
}

export function createStudioHandlers(
  s?: RemoteStudio,
  v?: RemoteVoice
): Pick<RemoteHandlers, StudioMethods> {
  const studio = (): RemoteStudio => {
    if (!s) throw new RemoteRpcError('not_implemented', 'Studio is not available from phones yet')
    return s
  }
  const voice = (): RemoteVoice => {
    if (!v) throw new RemoteRpcError('not_implemented', 'Dictation is not available from phones yet')
    return v
  }
  const item = (params: unknown) => {
    const p = rec(params)
    return { kind: kindOf(p.kind), id: itemId(p.id) }
  }
  return {
    'studio.status': () => studio().status(),
    'studio.load': async (params) => {
      await studio().load(modelId(rec(params).modelId))
      return { ok: true }
    },
    'studio.unload': async () => {
      await studio().unload()
      return { ok: true }
    },
    'studio.download': async (params) => {
      await studio().download(modelId(rec(params).modelId))
      return { ok: true }
    },
    'studio.generate': async (params) => {
      await studio().generate(parseGenerate(params))
      return { started: true }
    },
    'studio.stop': async () => {
      await studio().stop()
      return { ok: true }
    },
    'studio.gallery': async (params) => ({ items: await studio().gallery(kindOf(rec(params).kind)) }),
    'studio.media': async (params) => {
      const { kind, id } = item(params)
      const dataUrl = await studio().media(kind, id)
      if (!dataUrl) throw new RemoteRpcError('not_found', 'No such item')
      return { dataUrl }
    },
    'studio.remix': async (params) => {
      const { kind, id } = item(params)
      if (!(await studio().remix(kind, id))) throw new RemoteRpcError('not_found', 'No such item')
      return { started: true }
    },
    'studio.delete': async (params) => {
      const { kind, id } = item(params)
      await studio().remove(kind, id)
      return { ok: true }
    },
    'voice.status': () => ({ ready: !!v && v.ready() }),
    'voice.transcribe': async (params) => {
      const p = rec(params)
      const wav = decodeWav(p.audio)
      if (!voice().ready()) throw new RemoteRpcError('not_ready', 'Set up voice input on the computer first')
      const language = str(p.language).slice(0, 16) || undefined
      return { text: (await voice().transcribe(wav, language)).trim() }
    },
  }
}
