/**
 * A copy of an image small enough to keep in a saved session.
 *
 * The model gets the original; what is kept for the transcript (so the image
 * can be looked at again after a restart) is re-encoded with its longest side
 * capped, so a few phone photos do not turn a session file into hundreds of
 * megabytes. An image already small enough is kept as it is, and anything that
 * cannot be re-encoded here (no canvas, an undecodable image) is kept whole
 * rather than lost.
 */
export const KEPT_IMAGE_MAX_SIDE = 1600
export const KEPT_IMAGE_QUALITY = 0.85
/** Below this many characters of data URL an image is kept untouched. */
export const KEPT_IMAGE_SMALL_CHARS = 400_000

/** The scale that fits `w` x `h` within `maxSide`, never above 1. */
export function fitScale(w: number, h: number, maxSide = KEPT_IMAGE_MAX_SIDE): number {
  const longest = Math.max(w, h)
  return longest > maxSide ? maxSide / longest : 1
}

export async function shrinkImageDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.length < KEPT_IMAGE_SMALL_CHARS) return dataUrl
  try {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const scale = fitScale(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const webp = canvas.toDataURL('image/webp', KEPT_IMAGE_QUALITY)
    const out = webp.startsWith('data:image/webp')
      ? webp
      : canvas.toDataURL('image/jpeg', KEPT_IMAGE_QUALITY)
    // Never keep a copy bigger than the original.
    return out.length < dataUrl.length ? out : dataUrl
  } catch {
    return dataUrl
  }
}

/** Longest sides and qualities tried, largest and best first, to get under a size limit. */
const LIMIT_SIDES = [2560, 2048, 1600, 1280, 1024]
const LIMIT_QUALITIES = [0.9, 0.75]

export type EncodeImage = (
  file: File,
  maxSide: number,
  quality: number
) => Promise<Blob | null>

/** Decode `file` into a canvas no larger than `maxSide` and encode it as WebP (JPEG if WebP is not offered). */
export const encodeWithCanvas: EncodeImage = async (file, maxSide, quality) => {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
    return null
  }
  const bitmap = await createImageBitmap(file)
  try {
    const scale = fitScale(bitmap.width, bitmap.height, maxSide)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const toBlob = (type: string) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
    const webp = await toBlob('image/webp')
    if (webp && webp.type === 'image/webp') return webp
    return await toBlob('image/jpeg')
  } finally {
    bitmap.close?.()
  }
}

/**
 * An image over the attachment size limit, re-encoded smaller so it can be
 * attached instead of refused. A large screenshot is often a PNG far over the
 * limit that a model would read just as well at a lower resolution. Returns the
 * file untouched when it is already within the limit, is not an image, or
 * cannot be brought under it (it is then refused as too large, as before).
 */
export async function fitImageFileToLimit(
  file: File,
  maxBytes: number,
  encode: EncodeImage = encodeWithCanvas
): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= maxBytes) return file
  // An animation would be flattened to its first frame.
  if (file.type === 'image/gif') return file
  try {
    for (const side of LIMIT_SIDES) {
      for (const quality of LIMIT_QUALITIES) {
        const blob = await encode(file, side, quality)
        if (blob && blob.size <= maxBytes) {
          const ext = blob.type === 'image/jpeg' ? 'jpg' : 'webp'
          const stem = file.name.replace(/\.[^./\\]+$/, '') || 'image'
          return new File([blob], `${stem}.${ext}`, { type: blob.type })
        }
      }
    }
  } catch {
    // An image the browser cannot decode is left for validation to refuse.
  }
  return file
}
