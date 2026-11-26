import { toast } from 'sonner'
import { i18n } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import { isServedByFlint } from '@/lib/platform/utils'
import { studioApi, type GalleryItem } from '@/lib/studio/studio'

/** The name offered in the save dialog: `studio-<seed>`, the extension comes from the file. */
export const studioSaveName = (item: GalleryItem) => `studio-${item.recipe.seed}`

/**
 * Save a gallery picture or clip where the person chooses. The desktop app
 * cannot save through `<a download>` on a file URL (it opens the web preview),
 * so the backend copies the file after its own save dialog. In the browser
 * client the link works, and stays.
 */
export async function saveStudioItem(item: GalleryItem, browserUrl: string): Promise<void> {
  if (isServedByFlint()) {
    const link = document.createElement('a')
    link.href = browserUrl
    link.download = `${studioSaveName(item)}.${item.kind === 'video' ? 'mp4' : 'png'}`
    link.click()
    return
  }
  try {
    const path = await studioApi.saveCopy(item.kind, item.id, studioSaveName(item))
    if (path) toast.success(i18n.t('studio:prompt.savedTo', { path }))
  } catch (error) {
    toast.error(errorText(error))
  }
}
