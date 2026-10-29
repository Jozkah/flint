import {
  createAudioAttachment,
  createImageAttachment,
  createVideoAttachment,
  type Attachment,
} from '@/types/attachment'

/**
 * Reading a dropped or picked file into a data URL.
 *
 * `FileReader` reports a failed read through `onerror` or `onabort`; a promise
 * that only listens for `onload` never settles then, and the whole intake
 * (and every file queued behind it) waits forever.
 */
export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('read failed'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onabort = () => reject(new Error('read aborted'))
    reader.readAsDataURL(file)
  })
}

type Keyed = {
  id?: string
  contentHash?: string
  type: string
  name: string
  path?: string
}

/** What identifies an attachment across the copies the store makes of it. */
export const attachmentKey = (a: Keyed): string =>
  a.id ?? a.contentHash ?? `${a.type}:${a.name}:${a.path ?? ''}`

/**
 * `current` without the attachments that were sent. A file attached after the
 * send read its list is not in `sent`, so it stays for the next message.
 */
export function withoutSent<T extends Keyed>(current: T[], sent: Keyed[]): T[] {
  const gone = new Set(sent.map(attachmentKey))
  return current.filter((a) => !gone.has(attachmentKey(a)))
}

/*
 * The pure half of attaching media to the composer: which files qualify, what
 * attachment each becomes, which are already attached, and the sentence about
 * what was turned away. The composer keeps the state and the toasts.
 */

export const AUDIO_MAX_BYTES = 25 * 1024 * 1024
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024

// Video containers llama-server can decode via ffmpeg/ffprobe into frames.
export const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']

export const videoMimeForExt = (ext: string | undefined): string => {
  switch (ext) {
    case 'mov':
      return 'video/quicktime'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'avi':
      return 'video/x-msvideo'
    default:
      return 'video/mp4'
  }
}

/** The image type a file name implies, or empty when it is not a JPEG or PNG. */
export const imageMimeForName = (fileName: string): string => {
  switch (fileName.toLowerCase().split('.').pop()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    default:
      return ''
  }
}

/** SHA-256 of a base64 payload, as hex: the identity of an image's content. */
export async function hashBase64(base64: string): Promise<string> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** How long an audio file plays, or undefined when the browser cannot tell. */
export const decodeAudioDuration = (
  dataUrl: string
): Promise<number | undefined> =>
  new Promise((resolve) => {
    try {
      const audio = new Audio()
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => {
        const d = audio.duration
        resolve(Number.isFinite(d) && d > 0 ? d : undefined)
      }
      audio.onerror = () => resolve(undefined)
      audio.src = dataUrl
    } catch {
      resolve(undefined)
    }
  })

/** What preparing a batch of media files produced. */
export type MediaBatch = {
  prepared: Attachment[]
  /** Names of files of a type that cannot be attached. */
  invalid: string[]
  /** Names of files over the size limit. */
  oversized: string[]
}

type ReadFn = (file: Blob) => Promise<string>

/** WAV and MP3 under 25MB become audio attachments. */
export async function prepareAudioFiles(
  files: File[],
  deps: {
    read?: ReadFn
    duration?: (dataUrl: string) => Promise<number | undefined>
    hash?: (base64: string) => Promise<string>
  } = {}
): Promise<MediaBatch> {
  const read = deps.read ?? readAsDataUrl
  const duration = deps.duration ?? decodeAudioDuration
  const hash = deps.hash ?? hashBase64
  const batch: MediaBatch = { prepared: [], invalid: [], oversized: [] }
  for (const file of Array.from(files)) {
    const ext = file.name.toLowerCase().split('.').pop()
    const isWav =
      file.type === 'audio/wav' || file.type === 'audio/x-wav' || ext === 'wav'
    const isMp3 =
      file.type === 'audio/mpeg' || file.type === 'audio/mp3' || ext === 'mp3'
    if (!isWav && !isMp3) {
      batch.invalid.push(file.name)
      continue
    }
    if (file.size > AUDIO_MAX_BYTES) {
      batch.oversized.push(file.name)
      continue
    }
    const fmt: 'wav' | 'mp3' = isWav ? 'wav' : 'mp3'
    const mimeType = fmt === 'wav' ? 'audio/wav' : 'audio/mpeg'
    const dataUrl = await read(file)
    const base64 = dataUrl.split(',')[1] ?? ''
    const att = createAudioAttachment({
      name: file.name,
      base64,
      dataUrl,
      mimeType,
      audioFormat: fmt,
      size: file.size,
      durationSec: await duration(dataUrl),
    })
    if (base64) att.contentHash = await hash(base64)
    batch.prepared.push(att)
  }
  return batch
}

/** Video files under 100MB become video attachments. */
export async function prepareVideoFiles(
  files: File[],
  deps: { read?: ReadFn; hash?: (base64: string) => Promise<string> } = {}
): Promise<MediaBatch> {
  const read = deps.read ?? readAsDataUrl
  const hash = deps.hash ?? hashBase64
  const batch: MediaBatch = { prepared: [], invalid: [], oversized: [] }
  for (const file of Array.from(files)) {
    const ext = file.name.toLowerCase().split('.').pop()
    const isVideo =
      file.type.startsWith('video/') || VIDEO_EXTS.includes(ext ?? '')
    if (!isVideo) {
      batch.invalid.push(file.name)
      continue
    }
    if (file.size > VIDEO_MAX_BYTES) {
      batch.oversized.push(file.name)
      continue
    }
    const mimeType = file.type.startsWith('video/')
      ? file.type
      : videoMimeForExt(ext)
    const dataUrl = await read(file)
    const base64 = dataUrl.split(',')[1] ?? ''
    const att = createVideoAttachment({
      name: file.name,
      base64,
      dataUrl,
      mimeType,
      size: file.size,
    })
    if (base64) att.contentHash = await hash(base64)
    batch.prepared.push(att)
  }
  return batch
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The message lines for the files a media batch turned away. `t` localises
 * them; without it the lines are English, which keeps the pure helper usable
 * (and testable) without a translator.
 */
export function mediaBatchErrors(
  kind: 'audio' | 'video',
  batch: MediaBatch,
  t?: Translate
): string[] {
  const errors: string[] = []
  const label = kind === 'audio' ? 'Audio' : 'Video'
  const limit = kind === 'audio' ? '25MB' : '100MB'
  if (batch.oversized.length > 0) {
    errors.push(
      t
        ? t(`chat:composer.${kind}TooLarge`, {
            count: batch.oversized.length,
            limit,
            files: batch.oversized.join(', '),
          })
        : `${label} file${batch.oversized.length > 1 ? 's' : ''} too large (max ${limit}): ${batch.oversized.join(', ')}`
    )
  }
  if (batch.invalid.length > 0) {
    const plural = batch.invalid.length > 1 ? 's' : ''
    errors.push(
      t
        ? t(`chat:composer.${kind}Invalid`, {
            count: batch.invalid.length,
            files: batch.invalid.join(', '),
          })
        : kind === 'audio'
          ? `Invalid audio type${plural} (only WAV, MP3 allowed): ${batch.invalid.join(', ')}`
          : `Invalid video type${plural}: ${batch.invalid.join(', ')}`
    )
  }
  return errors
}

/**
 * Reads accepted image files into image attachments, with a content hash each.
 * A file that cannot be read is reported, never allowed to stall the rest.
 */
export async function prepareImageFiles(
  files: File[],
  deps: { read?: ReadFn; hash?: (base64: string) => Promise<string> } = {}
): Promise<{ prepared: Attachment[]; unreadable: string[] }> {
  const read = deps.read ?? readAsDataUrl
  const hash = deps.hash ?? hashBase64
  const prepared: Attachment[] = []
  const unreadable: string[] = []
  for (const file of files) {
    const detectedType = file.type || imageMimeForName(file.name)
    const actualType = imageMimeForName(file.name) || detectedType
    let result: string
    try {
      result = await read(file)
    } catch {
      unreadable.push(file.name)
      continue
    }
    prepared.push(
      createImageAttachment({
        name: file.name,
        size: file.size,
        mimeType: actualType,
        base64: result.split(',')[1],
        dataUrl: result,
      })
    )
  }
  // Hashes let two different pictures share a file name.
  for (const att of prepared) {
    if (att.base64) att.contentHash = await hash(att.base64)
  }
  return { prepared, unreadable }
}

/**
 * Splits prepared media from what the draft already holds, among attachments
 * of the same `type`. A file is a duplicate by content, or by name when the
 * held one has no content to hash; two copies inside one batch count too, and
 * two different files may share a name.
 */
export async function splitNewByContent(
  prepared: Attachment[],
  current: Attachment[],
  type: 'image' | 'audio' | 'video',
  hash: (base64: string) => Promise<string> = hashBase64
): Promise<{ fresh: Attachment[]; duplicates: string[] }> {
  const existingHashes = new Set<string>()
  const existingNames = new Set<string>()
  for (const a of current) {
    if (a.type !== type) continue
    if (a.contentHash) existingHashes.add(a.contentHash)
    else if (a.base64) existingHashes.add(await hash(a.base64))
    else existingNames.add(a.name)
  }
  const seenInBatch = new Set<string>()
  const fresh: Attachment[] = []
  const duplicates: string[] = []
  for (const att of prepared) {
    const h = att.contentHash ?? (att.base64 ? await hash(att.base64) : undefined)
    const dup =
      (h && (existingHashes.has(h) || seenInBatch.has(h))) ||
      existingNames.has(att.name)
    if (dup) {
      duplicates.push(att.name)
      continue
    }
    if (h) seenInBatch.add(h)
    fresh.push(att)
  }
  return { fresh, duplicates }
}

/** `splitNewByContent` for images. */
export const splitNewImages = (
  prepared: Attachment[],
  current: Attachment[],
  hash: (base64: string) => Promise<string> = hashBase64
) => splitNewByContent(prepared, current, 'image', hash)

/**
 * `list` without `target`. Removal waits on the backend (a document is
 * deleted from the vector store first), and the list can change meanwhile:
 * an earlier chip removed, an ingest finishing. An index taken before the
 * wait could then name a different chip, so the chip is found again by
 * identity, or, when an update replaced the object, by type, name and
 * content hash or path.
 */
export function withoutAttachment(
  list: Attachment[],
  target: Attachment
): Attachment[] {
  let at = list.indexOf(target)
  if (at === -1) {
    const key = (a: Attachment) => a.contentHash ?? a.path
    at = list.findIndex(
      (a) =>
        a.type === target.type &&
        a.name === target.name &&
        key(a) === key(target)
    )
  }
  return at === -1 ? list : list.filter((_, i) => i !== at)
}
