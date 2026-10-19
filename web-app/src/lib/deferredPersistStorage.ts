import type { PersistStorage, StorageValue } from 'zustand/middleware'

/**
 * Wraps a Zustand `PersistStorage` so writes leave the click that caused them.
 *
 * Zustand persist calls `setItem` on every `set()`. For the Cowork sessions
 * store that meant serializing, parsing, redacting and serializing again the
 * whole session list synchronously (hundreds of ms with real history) on
 * every New session press. Here the latest value is kept and written once,
 * `delay` ms after the first change, so a burst of sets (or a streaming run)
 * costs one write. A pending write is flushed when the page is hidden or
 * closed, so nothing is lost on exit.
 */
export function deferredPersistStorage<S>(
  inner: PersistStorage<S>,
  delay = 1500
): PersistStorage<S> & { flush: () => Promise<void> } {
  const pending = new Map<string, StorageValue<S>>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = async () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const writes = [...pending]
    pending.clear()
    await Promise.all(writes.map(([name, value]) => inner.setItem(name, value)))
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush()
    })
    window.addEventListener('pagehide', () => void flush())
  }

  return {
    getItem: (name) => inner.getItem(name),
    setItem: (name, value) => {
      pending.set(name, value)
      if (!timer) timer = setTimeout(() => void flush(), delay)
    },
    removeItem: (name) => {
      pending.delete(name)
      return inner.removeItem(name)
    },
    flush,
  }
}
