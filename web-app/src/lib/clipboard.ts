/**
 * Write `text` to the clipboard and say whether it worked. The write is
 * asynchronous and refused when the window is not focused or permission is
 * denied; a button that shows "copied" before it finishes tells the user a
 * secret is on the clipboard when it is not.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return false
    }
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
