import type { UIMessage } from 'ai'
import { SHOW_WIDGET_TOOL } from './constants'

/** Widgets in the newest this-many user turns keep their code in the request. */
export const WIDGET_CODE_KEEP_TURNS = 2
/** A widget this small is not worth a placeholder. */
const MIN_TRUNCATE_CHARS = 400

export const OMITTED_WIDGET_CODE = (chars: number): string =>
  `<!-- widget code omitted from history (${chars} chars); the widget was already shown to the user -->`

/**
 * Old `show_widget` calls replay their whole markup on every request, which
 * is the bulk of a chat that drew several widgets. After the newest
 * `keepTurns` user turns the code is swapped for a one-line note in the copy
 * sent to the model; the stored message is untouched, so the transcript still
 * redraws the original. Pure: unchanged messages come back as the same object.
 */
export function truncateStaleWidgetCode(
  messages: UIMessage[],
  keepTurns: number = WIDGET_CODE_KEEP_TURNS
): UIMessage[] {
  const toolType = `tool-${SHOW_WIDGET_TOOL}`
  let protectedFrom = 0
  let turns = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    turns++
    if (turns >= Math.max(1, keepTurns)) {
      protectedFrom = i
      break
    }
  }
  return messages.map((message, mi) => {
    if (mi >= protectedFrom || message.role !== 'assistant') return message
    let changed = false
    const parts = message.parts.map((part) => {
      if (part.type !== toolType) return part
      const input = (part as { input?: unknown }).input as
        | { widget_code?: unknown }
        | undefined
      const code = input?.widget_code
      if (typeof code !== 'string' || code.length < MIN_TRUNCATE_CHARS) return part
      if (code.startsWith('<!-- widget code omitted')) return part
      changed = true
      return {
        ...part,
        input: { ...input, widget_code: OMITTED_WIDGET_CODE(code.length) },
      } as typeof part
    })
    return changed ? { ...message, parts } : message
  })
}
