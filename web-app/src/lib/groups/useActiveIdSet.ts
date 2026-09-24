import { useMemo } from 'react'

/** Separator for id lists produced by store selectors (never part of an id). */
export const ID_SEP = '\u0000'

/**
 * Turns joined id strings (stable primitive selector output) into one Set,
 * rebuilt only when the ids change, so active indicators do not re-render the
 * whole list on unrelated store updates.
 */
export function useActiveIdSet(...keys: string[]): ReadonlySet<string> {
  const joined = keys.join(ID_SEP)
  return useMemo(() => new Set(joined.split(ID_SEP).filter(Boolean)), [joined])
}
