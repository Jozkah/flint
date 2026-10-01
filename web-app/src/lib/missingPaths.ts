import { useSyncExternalStore } from 'react'

/**
 * Inline path links whose file a click found missing, for this app run.
 * Detection stays lexical (no filesystem call per render); this only
 * remembers what a click already learned, so the link can dim. Keyed by the
 * session's folders as well as the path, because the same relative name means
 * a different file in another session.
 */
const missing = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (roots: readonly string[], path: string) =>
  `${roots.join('\u0000')}\u0001${path}`

const emit = () => {
  version++
  listeners.forEach((l) => l())
}

export function markPathMissing(
  roots: readonly string[],
  path: string,
  isMissing: boolean
): void {
  const key = keyOf(roots, path)
  if (isMissing === missing.has(key)) return
  if (isMissing) missing.add(key)
  else missing.delete(key)
  emit()
}

export const isPathKnownMissing = (
  roots: readonly string[],
  path: string
): boolean => missing.has(keyOf(roots, path))

/** Subscribes the caller to changes; returns whether this path is missing. */
export function useKnownMissing(
  roots: readonly string[],
  path: string
): boolean {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  return isPathKnownMissing(roots, path)
}

/** Test helper. */
export function resetMissingPaths(): void {
  missing.clear()
  emit()
}
