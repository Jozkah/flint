export type ListedModel = { id: string }

/**
 * Bring a provider's saved models in line with what its server lists now.
 *
 * New ids are added with `make`; saved models the server no longer lists are
 * dropped, so the model menu stops offering what cannot be used. An empty
 * listing is never taken as "remove everything": a server that answered with
 * nothing (or an unreadable list) leaves the saved models alone.
 */
export function syncListedModels<M extends ListedModel>(
  saved: readonly M[],
  listedIds: readonly string[],
  make: (id: string) => M
): { models: M[]; added: M[]; removed: M[] } {
  if (listedIds.length === 0) return { models: [...saved], added: [], removed: [] }
  const listed = new Set(listedIds)
  const have = new Set(saved.map((m) => m.id))
  const removed = saved.filter((m) => !listed.has(m.id))
  const added = [...new Set(listedIds)].filter((id) => !have.has(id)).map(make)
  return {
    models: [...saved.filter((m) => listed.has(m.id)), ...added],
    added,
    removed,
  }
}
