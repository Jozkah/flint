/**
 * sessionStorage that cannot take a send down with it.
 *
 * The first message of a new chat is handed to the thread route through
 * sessionStorage. It throws when the quota is full or storage is blocked
 * (private windows, some embedded webviews); an uncaught throw there aborted
 * the send after the draft had already been cleared. A write that fails is
 * kept in memory instead, for the same page session, and reads look at both.
 */
const memory = new Map<string, string>()

/** True when the value reached sessionStorage; false when it is held in memory. */
export function safeSessionSet(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(key, value)
    memory.delete(key)
    return true
  } catch {
    memory.set(key, value)
    return false
  }
}

export function safeSessionGet(key: string): string | null {
  try {
    const stored = sessionStorage.getItem(key)
    if (stored !== null) return stored
  } catch {
    // Fall through to the in-memory copy.
  }
  return memory.get(key) ?? null
}

export function safeSessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Nothing stored there to remove.
  }
  memory.delete(key)
}
