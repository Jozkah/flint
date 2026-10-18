/**
 * Rooms and Cowork sessions for the Ctrl+K search: found by title, so a room
 * or a session is reachable the same way a chat is.
 */
export type WorkItem = {
  kind: 'room' | 'session'
  id: string
  title: string
}

/** Title matches, every word of the query in any order, best first. */
export function searchWork(items: WorkItem[], query: string, limit = 5): WorkItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const scored: Array<{ item: WorkItem; score: number }> = []
  for (const item of items) {
    const title = item.title.toLowerCase()
    if (!words.every((w) => title.includes(w))) continue
    const score = title.startsWith(words[0]) ? 0 : 1
    scored.push({ item, score })
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.item)
}
