/** Longest a row title may be. */
export const MAX_TASK_TITLE_CHARS = 60

/**
 * The title a row shows for an errand: the model's own `title` when it gave
 * one, else the first sentence of the brief, trimmed. Never the role name: two
 * explorers on different jobs must not read as the same row.
 */
export function deriveTaskTitle(
  title: string | undefined,
  brief: string | undefined
): string | undefined {
  const clip = (text: string) => {
    const one = text.replace(/\s+/g, ' ').trim()
    return one.length > MAX_TASK_TITLE_CHARS
      ? `${one.slice(0, MAX_TASK_TITLE_CHARS - 1).trimEnd()}…`
      : one
  }
  const explicit = title ? clip(title) : ''
  if (explicit) return explicit
  const line = (brief ?? '').trim().split(/\n/)[0]
  // First sentence: cut after . ! or ? before whitespace (no lookbehind).
  const first = line.match(/^[\s\S]*?[.!?](?=\s)/)?.[0] ?? line
  const derived = clip(first.replace(/[.!?:]+$/, ''))
  return derived || undefined
}
