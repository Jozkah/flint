import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import type { ToolImage } from '@/lib/toolOutputImages'
import { listChatImages } from '@/lib/chatImages'
import { studioApi } from '@/lib/studio/studio'

const PNG_DATA_URL = /^data:image\/png;base64,(.+)$/s

/** Whether a picture can be saved: the backend's save dialog takes PNG only. */
export const canSaveToolImage = (image: ToolImage): boolean =>
  PNG_DATA_URL.test(image.dataUrl)

/**
 * Save a picture a tool returned. The save dialog is the backend's
 * (`export_save_file`), so no path comes from here. Returns where it went, or
 * `null` when the person cancelled.
 */
export async function saveToolImage(image: ToolImage): Promise<string | null> {
  const match = PNG_DATA_URL.exec(image.dataUrl)
  if (!match) throw new Error('This picture cannot be saved.')
  const report = await invoke<{ path: string } | null>('export_save_file', {
    ext: 'png',
    suggestedName: image.name.replace(/\.[a-z0-9]+$/i, ''),
    base64: match[1],
  })
  return report?.path ?? null
}

/** `saveToolImage` with the outcome told to the person. */
export async function saveToolImageWithToast(image: ToolImage): Promise<void> {
  try {
    const path = await saveToolImage(image)
    if (path) toast.success(`Saved ${path}`)
  } catch (e) {
    toast.error(errorText(e))
  }
}

/**
 * Save every picture a conversation made, one save dialog each (the backend
 * saves a file at a time). Stops at the first cancel. A picture deleted from the
 * Studio gallery is skipped and counted. Returns what happened.
 */
export async function saveChatPictures(
  threadId: string
): Promise<{ saved: number; missing: number; cancelled: boolean }> {
  let saved = 0
  let missing = 0
  for (const picture of listChatImages(threadId)) {
    if (picture.deleted) {
      missing++
      continue
    }
    let dataUrl: string
    try {
      dataUrl = await studioApi.media('image', picture.galleryId)
    } catch {
      missing++
      continue
    }
    const path = await saveToolImage({ dataUrl, name: picture.id })
    if (path === null) return { saved, missing, cancelled: true }
    saved++
  }
  return { saved, missing, cancelled: false }
}

/** `saveChatPictures` with the outcome told to the person. */
export async function saveChatPicturesWithToast(threadId: string): Promise<void> {
  try {
    const { saved, missing, cancelled } = await saveChatPictures(threadId)
    if (saved && !cancelled) {
      toast.success(
        `Saved ${saved} picture${saved === 1 ? '' : 's'}` +
          (missing ? `; ${missing} no longer in the gallery` : '')
      )
    } else if (!saved && !cancelled && missing) {
      toast.error('The pictures are no longer in the Studio gallery.')
    }
  } catch (e) {
    toast.error(errorText(e))
  }
}
