/**
 * Helpers for a Hugging Face search typed as words ("ornith 1.5 9b") rather
 * than as a repository id ("owner/Ornith-1.5-9B-GGUF").
 *
 * Hugging Face matches the whole query against a repository id, and ids use
 * hyphens and underscores where a person types spaces. Sorted by downloads, a
 * new model with few downloads then sinks under old, popular near-matches, or
 * is not returned at all.
 */

/** Lower-cased words of a query. */
export function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/[\s/]+/).filter(Boolean)
}

/** An id with the separators people type differently removed. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * The queries to send: the one typed, and, when it has several words, the
 * same words joined the way a repository id spells them.
 */
export function searchVariants(query: string): string[] {
  const trimmed = query.trim()
  const tokens = queryTokens(trimmed)
  if (tokens.length < 2 || trimmed.includes('/')) return [trimmed]
  return [trimmed, tokens.join('-')]
}

/** Whether every word of the query appears in the repository id. */
export function matchesAllWords(id: string, query: string): boolean {
  const tokens = queryTokens(query).map(squash).filter(Boolean)
  if (tokens.length === 0) return false
  const haystack = squash(id)
  return tokens.every((token) => haystack.includes(token))
}

/**
 * Moves the repositories that contain every word of the query ahead of the
 * rest, keeping the order within each group, so sorting by downloads cannot
 * bury the model that was asked for under near-matches.
 */
export function pinQueryMatches<T extends { id: string }>(
  models: T[],
  query: string
): T[] {
  if (queryTokens(query).length === 0) return models
  const hits: T[] = []
  const rest: T[] = []
  for (const model of models) {
    const bucket = matchesAllWords(model.id, query) ? hits : rest
    bucket.push(model)
  }
  return hits.length === 0 || rest.length === 0 ? models : [...hits, ...rest]
}

/** Merges result lists by repository id; the first list's copy wins. */
export function mergeById<T extends { id: string }>(lists: T[][]): T[] {
  const byId = new Map<string, T>()
  for (const list of lists) for (const model of list) if (!byId.has(model.id)) byId.set(model.id, model)
  return [...byId.values()]
}
