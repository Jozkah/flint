/**
 * Copy through a hidden textarea and `document.execCommand('copy')`. The
 * async Clipboard API is missing or refused in some webviews (Tauri on Linux
 * and Wayland, an unfocused window), while this older path still works inside
 * a user gesture. Returns whether the browser says the copy happened.
 */
export function copyViaExecCommand(text: string): boolean {
  if (
    typeof document === 'undefined' ||
    !document.body ||
    typeof document.execCommand !== 'function'
  ) {
    return false
  }
  const active = document.activeElement as HTMLElement | null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  area.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(area)
  try {
    area.focus()
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    active?.focus?.()
  }
}

/**
 * Write `text` to the clipboard and say whether it worked. The write is
 * asynchronous and refused when the window is not focused or permission is
 * denied; a button that shows "copied" before it finishes tells the user a
 * secret is on the clipboard when it is not. When the async API is missing or
 * refuses, the execCommand path is tried before giving up.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  return copyViaExecCommand(text)
}
