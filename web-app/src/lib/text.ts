/**
 * Cut `text` to at most `max` characters, the last one an ellipsis when
 * anything was cut. Text that already fits comes back unchanged.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}
