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
