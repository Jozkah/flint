import type { UIMessage } from '@ai-sdk/react'

/**
 * llama.cpp reads an image with stb_image, which cannot decode WebP, so a WebP
 * screenshot (the usual format of a web image) sent to a local vision model
 * either fails or is dropped. Flint accepts WebP in the attachment picker, so
 * the copy of the conversation sent to a local model carries it as PNG.
 */

/** The longest side kept when transcoding; a larger image is scaled down to it. */
export const TRANSCODE_MAX_SIDE = 4096

export type TranscodeToPng = (dataUrl: string) => Promise<string | null>

/** Decode an image data URL and encode it as a PNG data URL, or null if it cannot be done here. */
export const transcodeToPngWithCanvas: TranscodeToPng = async (dataUrl) => {
  if (
    typeof document === 'undefined' ||
    typeof createImageBitmap === 'undefined' ||
    typeof FileReader === 'undefined'
  ) {
    return null
  }
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > TRANSCODE_MAX_SIDE ? TRANSCODE_MAX_SIDE / longest : 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png')
    )
    if (!png) return null
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(png)
    })
  } finally {
    bitmap.close?.()
  }
}

type FilePart = { type: 'file'; mediaType?: string; url?: string }

const isWebpPart = (part: unknown): part is FilePart & { url: string } => {
  const p = part as FilePart | undefined
  return (
    !!p &&
    p.type === 'file' &&
    typeof p.url === 'string' &&
    (p.mediaType === 'image/webp' || p.url.startsWith('data:image/webp'))
  )
}

/**
 * The messages with every WebP image part replaced by a PNG one. A part that
 * cannot be transcoded is left as it was, so the request fails or drops it the
 * way it did before. Messages without a WebP part are returned by reference.
 */
export async function transcodeWebpImages(
  messages: UIMessage[],
  transcode: TranscodeToPng = transcodeToPngWithCanvas
): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.parts) || !message.parts.some(isWebpPart)) {
        return message
      }
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (!isWebpPart(part)) return part
          try {
            const png = await transcode(part.url)
            return png ? { ...part, url: png, mediaType: 'image/png' } : part
          } catch {
            return part
          }
        })
      )
      return { ...message, parts } as UIMessage
    })
  )
}
