import { useStudio } from '@/hooks/useStudio'
import type { Rect } from '@/lib/studio/mask'
import { studioApi, type GalleryItem } from '@/lib/studio/studio'

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode'))
    img.src = url
  })
}

/**
 * Keep `rect` (in the picture's own pixels) of a gallery picture as a new
 * gallery picture, so it can be upscaled on its own. The picture is read
 * through the backend as a data URL, so the canvas is never tainted.
 */
export async function cropToGallery(item: GalleryItem, rect: Rect, label: string): Promise<GalleryItem> {
  const img = await load(await studioApi.media('image', item.id))
  const canvas = document.createElement('canvas')
  canvas.width = rect.width
  canvas.height = rect.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas')
  ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  const png = canvas.toDataURL('image/png')
  const saved = await studioApi.saveExternalImages({
    prompt: item.recipe.prompt,
    width: rect.width,
    height: rect.height,
    modelId: 'selection-crop',
    modelName: label,
    durationMs: 0,
    images: [png.slice(png.indexOf(',') + 1)],
  })
  await useStudio.getState().refreshGallery('image')
  const added = useStudio.getState().gallery.image.find((g) => g.id === saved.ids[0])
  if (!added) throw new Error('missing')
  return added
}
