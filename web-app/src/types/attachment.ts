/**
 * Unified attachment type for images, documents, and audio
 */
export type Attachment = {
  name: string
  type: 'image' | 'document' | 'audio' | 'video'

  /** For audio attachments: 'wav' or 'mp3' per llama.cpp mtmd support. */
  audioFormat?: 'wav' | 'mp3'
  /** Audio/video duration in seconds (decoded client-side for the chip preview). */
  durationSec?: number

  // Common fields
  size?: number
  chunkCount?: number
  processing?: boolean
  processed?: boolean
  error?: string

  // Media content. New attachments hold only `dataUrl`; read the bytes with
  // `attachmentBase64`, which also understands an attachment made before
  // this change that holds a bare `base64` and no data URL.
  /** @deprecated Kept only so older attachments still read; never written. */
  base64?: string
  dataUrl?: string
  mimeType?: string
  contentHash?: string // Used for deduplication (different files can have same name)

  // For documents (local files)
  path?: string
  fileType?: string // e.g., 'pdf', 'docx'
  parseMode?: 'auto' | 'inline' | 'embeddings' | 'prompt'
  /** A PDF the user chose to send to a vision model as page images. */
  sendAsImages?: boolean

  // After processing (images uploaded, documents ingested)
  id?: string
  injectionMode?: 'inline' | 'embeddings'
  inlineContent?: string
}

/**
 * The base64 payload of a media attachment: derived from its data URL, or
 * the `base64` an older attachment stored. Undefined when it has neither.
 */
export function attachmentBase64(
  a: Pick<Attachment, 'base64' | 'dataUrl'>
): string | undefined {
  if (a.base64) return a.base64
  const url = a.dataUrl
  if (!url) return undefined
  const comma = url.indexOf(',')
  return comma === -1 ? undefined : url.slice(comma + 1) || undefined
}

/**
 * Helper to create image attachment
 */
export function createImageAttachment(data: {
  name: string
  dataUrl: string
  mimeType: string
  size: number
}): Attachment {
  return {
    ...data,
    type: 'image',
  }
}

/**
 * Helper to create audio attachment
 */
export function createAudioAttachment(data: {
  name: string
  dataUrl: string
  mimeType: string
  audioFormat: 'wav' | 'mp3'
  size: number
  durationSec?: number
}): Attachment {
  return {
    ...data,
    type: 'audio',
  }
}

/**
 * Helper to create video attachment
 */
export function createVideoAttachment(data: {
  name: string
  dataUrl: string
  mimeType: string
  size: number
  durationSec?: number
}): Attachment {
  return {
    ...data,
    type: 'video',
  }
}

/**
 * The attachments that go through the image ingest. Text and documents carry
 * their content inline and take their own path; the image ingest rejects them.
 */
export function attachmentsToIngestAsImages(
  attachments: readonly Attachment[]
): Attachment[] {
  return attachments.filter((a) => a.type === 'image')
}

/**
 * Helper to create document attachment
 */
export function createDocumentAttachment(data: {
  name: string
  path: string
  fileType?: string
  size?: number
  parseMode?: 'auto' | 'inline' | 'embeddings' | 'prompt'
}): Attachment {
  return {
    ...data,
    type: 'document',
  }
}
