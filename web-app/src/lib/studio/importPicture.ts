import { useStudio } from '@/hooks/useStudio'
import { studioApi, type GalleryItem } from '@/lib/studio/studio'

export const MAX_PICTURE_FILE_BYTES = 20 * 1024 * 1024
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** Why a file could not be brought into the gallery. */
export type ImportProblem = 'not-picture' | 'too-big' | 'failed'

export class PictureImportError extends Error {
  constructor(readonly problem: ImportProblem) {
    super(problem)
  }
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read'))
    reader.onload = () => {
      const text = String(reader.result)
      resolve(text.slice(text.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function measure(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode'))
    }
    img.src = url
  })
}

/** The first picture among dropped files, or null. */
export function firstPicture(files: FileList | readonly File[] | null | undefined): File | null {
  return Array.from(files ?? []).find((f) => PICTURE_TYPES.includes(f.type)) ?? null
}

/**
 * Keep a picture from this computer in the Studio gallery, so it can be used
 * like a made one (a reference, a picture to upscale or edit). Returns the
 * new gallery item.
 */
export async function importPicture(file: File, label: string): Promise<GalleryItem> {
  if (!PICTURE_TYPES.includes(file.type)) throw new PictureImportError('not-picture')
  if (file.size > MAX_PICTURE_FILE_BYTES) throw new PictureImportError('too-big')
  try {
    const [image, size] = await Promise.all([readBase64(file), measure(file)])
    const saved = await studioApi.saveExternalImages({
      prompt: file.name,
      width: size.width,
      height: size.height,
      modelId: 'imported-picture',
      modelName: label,
      durationMs: 0,
      images: [image],
    })
    await useStudio.getState().refreshGallery('image')
    const added = useStudio.getState().gallery.image.find((g) => g.id === saved.ids[0])
    if (!added) throw new Error('missing')
    return added
  } catch {
    throw new PictureImportError('failed')
  }
}
