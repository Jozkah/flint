// Bounded id-keyed record helpers for the approval store, split out of
// hooks/useToolApprovalRequests.ts.

/** Refusal reasons are kept for this many calls, newest last. */
const REFUSAL_MEMORY = 200

export function remember<T>(
  map: Record<string, T>,
  entries: [string, T][]
): Record<string, T> {
  const next = { ...map }
  for (const [id, value] of entries) {
    delete next[id]
    next[id] = value
  }
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - REFUSAL_MEMORY))) {
    delete next[key]
  }
  return next
}

/** `map` without the given call ids; the same object when none was there. */
export function forget<T>(map: Record<string, T>, ids: string[]): Record<string, T> {
  if (!ids.some((id) => id in map)) return map
  const next = { ...map }
  for (const id of ids) delete next[id]
  return next
}
