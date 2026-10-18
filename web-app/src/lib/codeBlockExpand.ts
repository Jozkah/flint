/**
 * Which capped code blocks the user expanded, remembered for the session so a
 * re-render or revisiting the chat keeps the block open. Keyed by message id
 * and block position.
 */
const KEY = 'flint:code-expanded'
let cache: Set<string> | null = null

function load(): Set<string> {
  if (cache) return cache
  try {
    const raw = sessionStorage.getItem(KEY)
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    cache = new Set()
  }
  return cache
}

export function isCodeBlockExpanded(id: string): boolean {
  return load().has(id)
}

export function setCodeBlockExpanded(id: string, expanded: boolean): void {
  const set = load()
  if (expanded) set.add(id)
  else set.delete(id)
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...set]))
  } catch {
    /* storage unavailable: keep the in-memory state */
  }
}

/** Test hook: forget the in-memory copy so the next read hits storage. */
export function resetCodeBlockExpandCache(): void {
  cache = null
}
