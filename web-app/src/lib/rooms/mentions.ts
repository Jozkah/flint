/**
 * `@name` mentions in the room composer: the word being typed after `@`, and
 * the participant a message that starts with `@Name` is addressed to.
 */

export type MentionTarget = { value: string; label: string }

/** The `@word` the caret sits at the end of, or null. */
export function mentionAt(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  return { start: before.length - match[2].length - 1, query: match[2] }
}

/** Targets whose label matches the typed query, prefix matches first. */
export function mentionOptions<T extends MentionTarget>(targets: T[], query: string): T[] {
  const q = query.toLowerCase()
  const starts = targets.filter((x) => x.label.toLowerCase().startsWith(q))
  const contains = targets.filter(
    (x) => !x.label.toLowerCase().startsWith(q) && x.label.toLowerCase().includes(q)
  )
  return [...starts, ...contains]
}

/** Replace the `@query` at `start` with `@Label ` and return the new text and caret. */
export function insertMention(
  text: string,
  start: number,
  query: string,
  label: string
): { text: string; caret: number } {
  const inserted = `@${label} `
  const end = start + 1 + query.length
  const rest = text.slice(end).replace(/^ /, '')
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length }
}

/**
 * The target a message beginning with `@Name` addresses, or null. The longest
 * matching name wins, so "@Bob Smith" picks Bob Smith over Bob, and the name
 * must end at a space, punctuation or the end of the text.
 */
export function mentionedTarget<T extends MentionTarget>(text: string, targets: T[]): T | null {
  const body = text.trimStart()
  if (!body.startsWith('@')) return null
  const rest = body.slice(1).toLowerCase()
  const hits = targets
    .filter((x) => {
      const name = x.label.toLowerCase()
      if (!name || !rest.startsWith(name)) return false
      const next = rest.charAt(name.length)
      return next === '' || /[\s,.:;!?]/.test(next)
    })
    .sort((a, b) => b.label.length - a.label.length)
  return hits[0] ?? null
}
