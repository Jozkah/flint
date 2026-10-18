import type { UIMessage } from 'ai'

/**
 * Find a phrase in a conversation, for the find bar.
 *
 * Only text the user can read is searched: the text parts of each message, in
 * order. Reasoning, tool input and output, and messages the conversation hides
 * (a compaction summary) are not. The match is case-insensitive and literal;
 * the query is never read as a pattern.
 */

export type FindMatch = {
  messageId: string
  /** Index of the part in the message's parts. */
  partIndex: number
  /** Offset of the match in that part's text. */
  start: number
  length: number
  /** Which occurrence this is within its message, counting from 0. */
  ordinal: number
}

export function findInMessages(
  messages: readonly UIMessage[],
  query: string
): FindMatch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const matches: FindMatch[] = []
  for (const message of messages) {
    const meta = message.metadata as { hidden?: boolean } | undefined
    if (meta?.hidden) continue
    let ordinal = 0
    ;(message.parts ?? []).forEach((part, partIndex) => {
      if (part.type !== 'text') return
      const text = (part as { text?: unknown }).text
      if (typeof text !== 'string' || !text) return
      const hay = text.toLowerCase()
      let from = 0
      for (;;) {
        const at = hay.indexOf(needle, from)
        if (at === -1) break
        matches.push({
          messageId: message.id,
          partIndex,
          start: at,
          length: needle.length,
          ordinal: ordinal++,
        })
        from = at + needle.length
      }
    })
  }
  return matches
}

/**
 * The text ranges of `query` inside the rendered elements of one message, in
 * document order. Markdown syntax is gone by then, so this is what is on
 * screen, which can differ from the raw text the matches above came from.
 */
export function rangesInElements(
  elements: readonly Element[],
  query: string
): Range[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const ranges: Range[] = []
  for (const element of elements) {
    const doc = element.ownerDocument
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? ''
      const hay = text.toLowerCase()
      let from = 0
      for (;;) {
        const at = hay.indexOf(needle, from)
        if (at === -1) break
        const range = doc.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        ranges.push(range)
        from = at + needle.length
      }
    }
  }
  return ranges
}
