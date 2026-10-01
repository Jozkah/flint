import { isPlatformTauri } from '@/lib/platform/utils'

/**
 * The image model and a chat model do not both fit on most graphics cards, so
 * starting a chat model first stops the image model if one is loaded. Nothing
 * happens when none is, or outside the desktop app.
 */
export async function releaseImageModelForChat(): Promise<void> {
  if (!isPlatformTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('diffusion_unload')
  } catch {
    // The image engine being unavailable must never stop a chat model from loading.
  }
}
