import { VIDEO_EXTS } from '@/lib/attachmentIntake'
import {
  reasonMessageKey,
  type RejectionReason,
} from '@/lib/attachmentSupport'
import type { EnableableCapability } from '@/lib/modelCapabilityEnable'

/*
 * The pure half of how files reach the composer by drop and paste: which
 * pile each file goes on, which model capabilities that needs, and the
 * sentence about the files that were turned away. The composer keeps the
 * state, the toasts and the attaching.
 */

const AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3']

const extOf = (name: string) => name.toLowerCase().split('.').pop()

/** WAV or MP3, by type or extension. */
export const isAudioFile = (f: File): boolean => {
  const ext = extOf(f.name)
  return AUDIO_TYPES.includes(f.type) || ext === 'wav' || ext === 'mp3'
}

/** A video type, or a container extension llama-server can decode. */
export const isVideoFile = (f: File): boolean =>
  f.type.startsWith('video/') || VIDEO_EXTS.includes(extOf(f.name) ?? '')

export type DroppedFiles = {
  audio: File[]
  video: File[]
  documents: File[]
  /** Everything else: it goes down the image path, which sorts it further. */
  images: File[]
}

/** Sorts dropped files: audio first, then video, then documents, then the rest. */
export function splitDroppedFiles(
  dropped: File[],
  isDocument: (name: string) => boolean
): DroppedFiles {
  const audio = dropped.filter(isAudioFile)
  const video = dropped.filter((f) => !audio.includes(f) && isVideoFile(f))
  const other = dropped.filter((f) => !audio.includes(f) && !video.includes(f))
  const documents = other.filter((f) => isDocument(f.name))
  const images = other.filter((f) => !documents.includes(f))
  return { audio, video, documents, images }
}

/** The capabilities a batch of audio and video needs that the model lacks. */
export function missingMediaCapabilities(
  counts: { audio: number; video: number },
  supported: { audio: boolean; video: boolean }
): EnableableCapability[] {
  const missing: EnableableCapability[] = []
  if (counts.audio > 0 && !supported.audio) missing.push('audio')
  if (counts.video > 0 && !supported.video) missing.push('video')
  return missing
}

/** Audio and video files among pasted clipboard items, by item type. */
export function pastedMediaFiles(items: ArrayLike<DataTransferItem>): {
  audio: File[]
  video: File[]
} {
  const audio: File[] = []
  const video: File[] = []
  for (const item of Array.from(items)) {
    const file = item.getAsFile()
    if (!file) continue
    if (AUDIO_TYPES.includes(item.type)) audio.push(file)
    else if (item.type.startsWith('video/')) video.push(file)
  }
  return { audio, video }
}

/**
 * The image files among pasted clipboard items. `found` is false when there
 * were no image items at all; image items that yield no file come back as
 * `found` with no files, so the caller can try the async clipboard instead.
 */
export function pastedImageFiles(items: ArrayLike<DataTransferItem>): {
  found: boolean
  files: File[]
} {
  const imageItems = Array.from(items).filter((item) =>
    item.type.startsWith('image/')
  )
  const files: File[] = []
  for (const item of imageItems) {
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return { found: imageItems.length > 0, files }
}

/**
 * Whether a paste may carry an image the async clipboard could read. Never
 * for plain text: reading the clipboard that way makes WebView2 ask the user
 * for permission.
 */
export function clipboardMayHoldImage(types: readonly string[]): boolean {
  return (
    types.length === 0 ||
    types.includes('Files') ||
    types.some((type) => type.startsWith('image/')) ||
    (types.includes('text/html') && !types.includes('text/plain'))
  )
}

/** Reads the image blobs of async clipboard items into named files. */
export async function clipboardImageFiles(
  items: readonly ClipboardItem[],
  now: () => number = Date.now
): Promise<File[]> {
  const files: File[] = []
  for (const item of items) {
    for (const type of item.types.filter((t) => t.startsWith('image/'))) {
      try {
        const blob = await item.getType(type)
        const extension = type.split('/')[1] || 'png'
        files.push(
          new File([blob], `pasted-image-${now()}.${extension}`, { type })
        )
      } catch (error) {
        console.error('Error reading clipboard item:', error)
      }
    }
  }
  return files
}

/** The image type the desktop picker gives a chosen file: PNG, else JPEG. */
export const pickedImageMime = (fileName: string): string =>
  extOf(fileName) === 'png' ? 'image/png' : 'image/jpeg'

/**
 * One line per rejection reason, naming the files it applies to, in the
 * order the reasons first appear.
 */
export function rejectionLines(
  rejected: { name: string; reason: RejectionReason }[],
  t: (key: string) => string
): string[] {
  const byReason = new Map<RejectionReason, string[]>()
  for (const item of rejected) {
    byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item.name])
  }
  return [...byReason].map(
    ([reason, names]) => `${t(reasonMessageKey(reason))}: ${names.join(', ')}`
  )
}

/**
 * Whether a paste carries text that should be inserted as text even though an
 * image rides along with it. A copied file (`Files`) is always an attachment.
 */
export function pasteIsTextFirst(
  data: Pick<DataTransfer, 'types' | 'getData'> | null | undefined
): boolean {
  if (!data) return false
  const types = Array.from(data.types ?? [])
  if (types.includes('Files')) return false
  if (!types.includes('text/plain')) return false
  return data.getData('text/plain').trim().length > 0
}
