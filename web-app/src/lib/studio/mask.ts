/**
 * The pure parts of drawing a selection on a Studio picture: where the picture
 * sits inside its frame, how big the mask is, and turning what was painted
 * into the black-and-white mask the engine reads (white is repainted).
 */

export type Size = { width: number; height: number }
export type Rect = { x: number; y: number; width: number; height: number }

/**
 * Longest side of the mask. The engine resizes it to the edit's size (at most
 * the model's own, usually 1024) anyway, and every undo step keeps a copy.
 */
export const MASK_MAX_SIDE = 1024

/** Where a picture of `natural` size lands inside `box` with `object-fit: contain`. */
export function containRect(box: Size, natural: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || natural.width <= 0 || natural.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(box.width / natural.width, box.height / natural.height)
  const width = natural.width * scale
  const height = natural.height * scale
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }
}

/** The mask's own size: the picture's, scaled down so its longest side fits. */
export function maskSize(natural: Size, maxSide = MASK_MAX_SIDE): Size {
  const scale = Math.min(1, maxSide / Math.max(natural.width, natural.height, 1))
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  }
}

/** A point on screen, in mask pixels, given where the mask is drawn on screen. */
export function toMaskPoint(
  client: { x: number; y: number },
  shown: { left: number; top: number; width: number; height: number },
  mask: Size
): { x: number; y: number } {
  return {
    x: ((client.x - shown.left) / Math.max(shown.width, 1)) * mask.width,
    y: ((client.y - shown.top) / Math.max(shown.height, 1)) * mask.height,
  }
}

/** The rectangle between two corners, in any drag direction. */
export function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/**
 * The painted overlay (RGBA, painted where alpha is set) as the engine's mask:
 * opaque white where painted, opaque black elsewhere. Returns whether anything
 * was painted, so an empty selection is never sent.
 */
export function overlayToMask(rgba: Uint8ClampedArray): { pixels: Uint8ClampedArray<ArrayBuffer>; painted: boolean } {
  const pixels = new Uint8ClampedArray(rgba.length)
  let painted = false
  for (let i = 0; i < rgba.length; i += 4) {
    const on = rgba[i + 3] > 0
    if (on) painted = true
    const v = on ? 255 : 0
    pixels[i] = v
    pixels[i + 1] = v
    pixels[i + 2] = v
    pixels[i + 3] = 255
  }
  return { pixels, painted }
}

/** The overlay with painted and unpainted swapped, painted in `color` (RGBA). */
export function invertOverlay(rgba: Uint8ClampedArray, color: readonly [number, number, number, number]): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 0) continue
    out[i] = color[0]
    out[i + 1] = color[1]
    out[i + 2] = color[2]
    out[i + 3] = color[3]
  }
  return out
}

/** Whether any pixel of the overlay is painted. */
export function hasPaint(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) return true
  return false
}

/** The smallest rectangle around every painted pixel of the overlay, or null. */
export function paintedBounds(rgba: Uint8ClampedArray, width: number, height: number): Rect | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * A rectangle in mask pixels as whole pixels of the picture, grown outward so
 * nothing painted is cut off, and kept inside the picture.
 */
export function toPictureRect(rect: Rect, mask: Size, picture: Size): Rect {
  const sx = picture.width / mask.width
  const sy = picture.height / mask.height
  const x = Math.max(0, Math.floor(rect.x * sx))
  const y = Math.max(0, Math.floor(rect.y * sy))
  const right = Math.min(picture.width, Math.ceil((rect.x + rect.width) * sx))
  const bottom = Math.min(picture.height, Math.ceil((rect.y + rect.height) * sy))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}
