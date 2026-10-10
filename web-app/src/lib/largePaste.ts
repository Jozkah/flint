/**
 * A paste past either limit is attached as a text file instead of being
 * dropped into the composer, where it would bury the message being written.
 */
export const LARGE_PASTE_MAX_LINES = 20
export const LARGE_PASTE_MAX_CHARS = 8000

/** The composer's attach pipeline refuses files larger than this. */
export const LARGE_PASTE_MAX_BYTES = 10 * 1024 * 1024

const NAME_PATTERN = /^pasted-text-(\d+)\.txt$/

export function isLargePaste(text: string): boolean {
  if (text.length > LARGE_PASTE_MAX_CHARS) return true
  // Lines are counted without allocating the split of a long string.
  let lines = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines > LARGE_PASTE_MAX_LINES) return true
  }
  return false
}

/** The next free `pasted-text-<n>.txt` given the names already attached. */
export function nextPastedTextName(existing: readonly string[]): string {
  let highest = 0
  for (const name of existing) {
    const match = NAME_PATTERN.exec(name)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `pasted-text-${highest + 1}.txt`
}
