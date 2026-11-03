/** Rooms read per round while the list fills in its cards and statistics. */
export const PEEK_BATCH = 12

/**
 * Every room id, most recently updated first, in groups of `size`. The rooms
 * a person is looking at (and the ones that can have turns this week) come
 * back in the first rounds; the rest follow, so no room is left out of the
 * weekly statistics.
 */
export function peekBatches(
  summaries: ReadonlyArray<{ id: string; updatedAt: number }>,
  size: number = PEEK_BATCH
): string[][] {
  const ids = [...summaries]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => s.id)
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
