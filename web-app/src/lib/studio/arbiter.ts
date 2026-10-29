import { isPlatformTauri } from '@/lib/platform/utils'
import { invokeCommand } from '@/lib/backend'

/**
 * The image model and a chat model do not both fit on most graphics cards, so
 * starting a chat model first stops the image model if one is loaded. Nothing
 * happens when none is, or outside the desktop app.
 */
export async function releaseImageModelForChat(): Promise<void> {
  if (!isPlatformTauri()) return
  try {
    await invokeCommand('diffusion_unload')
  } catch {
    // The image engine being unavailable must never stop a chat model from loading.
  }
}
