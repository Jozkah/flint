/**
 * What comes back from the speech model is not always a transcript. Asked about
 * audio it cannot make out, a model made for conversation answers it, refuses,
 * or repeats the instruction it was given. These checks keep that out of the
 * message box.
 */

/** The most characters a second of speech plausibly holds, plus a fixed allowance. */
const CHARS_PER_SECOND = 48
const BASE_ALLOWANCE = 30

/**
 * Whether `text` can be a transcript of `seconds` of audio: not empty, not a
 * markdown block, not several paragraphs, and not far longer than speech could
 * fill in that time.
 */
export function isPlausibleTranscript(text: string, seconds: number): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.includes('```')) return false
  if ((trimmed.match(/\n/g) ?? []).length > 2) return false
  return trimmed.length <= seconds * CHARS_PER_SECOND + BASE_ALLOWANCE
}

/**
 * The language instruction sent with a phrase, and the form the model sometimes
 * repeats it in, `lang:fr`. Removes that echo from the start of a transcript.
 */
export function stripEchoedLanguage(text: string): string {
  return text.replace(/^\s*lang:[A-Za-z-]{2,8}\s*/i, '').trim()
}

/** A transcript ready to join onto the message being written. */
export function cleanTranscript(text: string): string {
  return stripEchoedLanguage(text).replace(/\s+/g, ' ').trim()
}
