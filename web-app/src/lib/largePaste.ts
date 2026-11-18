/**
 * A paste past either limit is attached as a text file instead of being
 * dropped into the composer, where it would bury the message being written.
 */
export const LARGE_PASTE_MAX_LINES = 20
export const LARGE_PASTE_MAX_CHARS = 8000

/**
 * A paste past this many characters (about 60K tokens) is worth a warning
 * before it is sent, whatever the model's context window is: with an unknown
 * window nothing else would say it may fill the context or be refused.
 */
export const LARGE_PASTE_WARN_CHARS = 200_000
/** What "keep the first part" keeps (about 30K tokens). */
export const LARGE_PASTE_TRIM_CHARS = 100_000
/** Rough characters per token for English text, for the size shown in the warning. */
const CHARS_PER_TOKEN = 3.4

/** A token count for the warning: an estimate, rounded to the nearest thousand. */
export function estimatePasteTokens(chars: number): number {
  return Math.max(1000, Math.round(chars / CHARS_PER_TOKEN / 1000) * 1000)
}

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
