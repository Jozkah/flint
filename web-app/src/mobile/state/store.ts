import { useSyncExternalStore } from 'react'

/** A tiny store: state, `set`, and a selector hook. The phone app keeps its
 * own (no zustand) so its bundle stays free of the desktop's stores. */
export function createStore<S extends object>(initial: S) {
  let state = initial
  const listeners = new Set<() => void>()
  const get = () => state
  const set = (patch: Partial<S> | ((s: S) => Partial<S>)) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    state = { ...state, ...next }
    listeners.forEach((l) => l())
  }
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
  function use<T>(select: (s: S) => T): T {
    return useSyncExternalStore(subscribe, () => select(state), () => select(state))
  }
  const reset = () => {
    state = initial
    listeners.forEach((l) => l())
  }
  return { get, set, subscribe, use, reset }
}
