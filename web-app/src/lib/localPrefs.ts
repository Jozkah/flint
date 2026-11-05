/**
 * Small JSON values kept in localStorage. Both calls swallow a blocked,
 * full or corrupt store so a caller only decides what "nothing saved" means.
 */

/** The parsed value under `key`, or undefined when absent or unreadable. */
export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : undefined
  } catch {
    return undefined
  }
}

/** Save `value` as JSON; returns false when the store refused it. */
export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
