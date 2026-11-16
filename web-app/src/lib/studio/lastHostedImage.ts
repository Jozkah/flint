import { localStorageKey } from '@/constants/localStorage'

/**
 * The hosted picture model (`provider/model`) last used in Studio. The chat
 * picture tools use it when no local picture model is loaded, so a user who
 * generates with a hosted model in Studio gets the same one in chat. Storage
 * can be blocked or empty; both read as "none".
 */
export function readLastHostedImageModel(): string | undefined {
  try {
    const value = globalThis.localStorage?.getItem(localStorageKey.lastHostedImageModel)
    return value?.trim() || undefined
  } catch {
    return undefined
  }
}

export function writeLastHostedImageModel(key: string): void {
  try {
    globalThis.localStorage?.setItem(localStorageKey.lastHostedImageModel, key)
  } catch {
    // Only a convenience; nothing depends on it being saved.
  }
}
