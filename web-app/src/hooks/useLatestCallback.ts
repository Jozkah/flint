import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A callback whose identity never changes but which always runs the `fn` of
 * the latest render. For handlers passed to memoized children whose
 * comparator ignores callback props: a stable identity keeps the memo, and
 * reading the latest `fn` means the handler never sees stale state.
 */
export function useLatestCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
