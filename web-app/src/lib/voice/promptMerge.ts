/**
 * Caret and splice math for dictation.
 *
 * Dictated text goes into the message box at the caret the user had when they
 * pressed the microphone, and everything to the right of it is kept. The whole
 * insertion is recomputed from that anchor each time a phrase arrives, so doing
 * it twice changes nothing and one call can undo the entire session. The shape
 * follows Atomic-Chat's dictation (Apache-2.0).
 *
 * Pure on purpose: the spacing and offset rules are easy to get wrong and hard
 * to debug through a React tree.
 */

export type DictationAnchor = {
  /** Text left of the caret when dictation started. */
  before: string
  /** Text right of the caret when dictation started, kept as it was. */
  after: string
}

/** Punctuation that belongs to the word before it, not to a new one. */
const HUGS_PREVIOUS_WORD = /^[\s,.!?;:)\]}»”’…%]/
const ENDS_WITH_WHITESPACE = /\s$/

/** Split `value` at the caret. No caret (field not focused) means the end. */
export function captureAnchor(
  value: string,
  caret: number | null | undefined
): DictationAnchor {
  if (caret === null || caret === undefined) return { before: value, after: '' }
  const at = Math.max(0, Math.min(caret, value.length))
  return { before: value.slice(0, at), after: value.slice(at) }
}

/** Join with one space, unless the left side is empty or ends in space, or the right opens with closing punctuation. */
export function joinSegment(before: string, segment: string): string {
  if (!segment) return before
  if (!before) return segment
  if (ENDS_WITH_WHITESPACE.test(before)) return before + segment
  if (HUGS_PREVIOUS_WORD.test(segment)) return before + segment
  return `${before} ${segment}`
}

/** Add one finished phrase to what the session has transcribed so far. */
export function appendSegment(committed: string, segment: string): string {
  const trimmed = segment.trim()
  return trimmed ? joinSegment(committed, trimmed) : committed
}

export type DictationMerge = {
  value: string
  /** Where the caret goes: the end of the dictated text. */
  caret: number
  /** How many characters the session put between `before` and `after`. */
  insertedLength: number
}

/** The whole message-box value for the transcript so far. */
export function mergeDictation(
  anchor: DictationAnchor,
  committed: string
): DictationMerge {
  const head = joinSegment(anchor.before, committed)
  const tail = anchor.after
  const needsSeparator =
    head.length > 0 &&
    tail.length > 0 &&
    !ENDS_WITH_WHITESPACE.test(head) &&
    !HUGS_PREVIOUS_WORD.test(tail)
  const value = needsSeparator ? `${head} ${tail}` : head + tail
  return {
    value,
    caret: head.length,
    insertedLength: value.length - anchor.before.length - anchor.after.length,
  }
}

/**
 * Take out exactly what the session inserted. Null when the text around it no
 * longer matches the anchor (the user typed during dictation): then nothing is
 * removed, so no one's typing is eaten.
 */
export function revertDictation(
  value: string,
  anchor: DictationAnchor,
  insertedLength: number
): { value: string; caret: number } | null {
  if (insertedLength < 0) return null
  const tailStart = anchor.before.length + insertedLength
  if (tailStart > value.length) return null
  if (!value.startsWith(anchor.before)) return null
  if (value.slice(tailStart) !== anchor.after) return null
  return {
    value: anchor.before + anchor.after,
    caret: anchor.before.length,
  }
}
