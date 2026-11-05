import type { UIMessage } from 'ai'

export function latestUserMessage(messages: UIMessage[]): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return { id: message.id, text }
  }
  return null
}

/** Notes Flint adds as user turns (nudges, recovery); the user typed none of them. */
const FLINT_NOTE = /^Note from Flint \(not typed by the user/

/**
 * The text of the last request the user typed. A Flint note is skipped
 * (RQA-010): the delegation nudge says "survey", which turned the system
 * prompt's survey hint on mid-run, told the model its first call must be
 * `task`, and changed the prompt prefix so every later step was re-read
 * uncached.
 */
export function lastUserText(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = m.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
      .trim()
    if (FLINT_NOTE.test(text)) continue
    return text
  }
  return undefined
}
