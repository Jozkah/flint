// Large photos are shrunk on the phone before they are sent: a 12 MP camera
// shot is 4-8 MB and no vision model needs more than about 2048 px.

export const MAX_EDGE = 2048
/** Images under this size and edge are sent as they are. */
export const KEEP_BYTES = 1.5 * 1024 * 1024

/** The size to draw at, keeping the aspect ratio; null when no change. */
export function fitWithin(w: number, h: number, max = MAX_EDGE): { w: number; h: number } | null {
  if (w <= max && h <= max) return null
  const k = max / Math.max(w, h)
  return { w: Math.round(w * k), h: Math.round(h * k) }
}

type Deps = {
  decode: (f: Blob) => Promise<{ width: number; height: number; close?: () => void } & CanvasImageSource>
  encode: (img: CanvasImageSource, w: number, h: number) => Promise<Blob | null>
}

const browserDeps: Deps = {
  decode: (f) => createImageBitmap(f),
  encode: (img, w, h) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')?.drawImage(img, 0, 0, w, h)
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85))
  },
}

/** A JPEG no larger than MAX_EDGE for big photos; anything else unchanged
 * (GIFs keep their animation, unreadable images go as they are and the
 * computer decides). */
export async function downscaleImage(file: File, deps: Deps = browserDeps): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file
  let img: Awaited<ReturnType<Deps['decode']>>
  try {
    img = await deps.decode(file)
  } catch {
    return file
  }
  const fit = fitWithin(img.width, img.height) ?? (file.size > KEEP_BYTES ? { w: img.width, h: img.height } : null)
  if (!fit) {
    img.close?.()
    return file
  }
  const blob = await deps.encode(img, fit.w, fit.h)
  img.close?.()
  if (!blob || blob.size >= file.size) return file
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  return new File([blob], name, { type: 'image/jpeg' })
}
