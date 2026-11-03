/**
 * The set of session ids that are compacting, after `id` is marked on or off.
 * Returns the same set when nothing changes so React skips the re-render.
 */
export function withCompacting(
  current: ReadonlySet<string>,
  id: string,
  on: boolean
): ReadonlySet<string> {
  if (current.has(id) === on) return current
  const next = new Set(current)
  if (on) next.add(id)
  else next.delete(id)
  return next
}
