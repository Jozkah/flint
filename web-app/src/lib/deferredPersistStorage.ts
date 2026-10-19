import type { PersistStorage, StorageValue } from 'zustand/middleware'

/** Events the desktop close handler and this module use to flush before exit. */
export const FLUSH_BEFORE_EXIT_EVENT = 'flush-before-exit'
export const FLUSH_BEFORE_EXIT_DONE_EVENT = 'flush-before-exit-done'

const flushers = new Set<() => Promise<void>>()

/** Write every deferred store's pending value now. Never rejects. */
export const flushDeferredStores = async (): Promise<void> => {
  await Promise.all([...flushers].map((f) => f()))
}

let exitFlushInstalled = false

/**
 * Desktop: the window can close before `visibilitychange` / `pagehide` run or
 * finish, so the Rust close handler asks for a flush and waits for the answer.
 */
function installExitFlush() {
  if (exitFlushInstalled || typeof window === 'undefined') return
  if (!('__TAURI_INTERNALS__' in window)) return
  exitFlushInstalled = true
  void import('@tauri-apps/api/event')
    .then(async ({ listen, emit }) => {
      await listen(FLUSH_BEFORE_EXIT_EVENT, async () => {
        try {
          await flushDeferredStores()
        } finally {
          await emit(FLUSH_BEFORE_EXIT_DONE_EVENT)
        }
      })
    })
    .catch((e) => console.warn('flush-before-exit listener failed:', e))
}

export type DeferredPersistOptions = {
  /** Delay while `busy()` is false: nothing is streaming, so write soon. */
  idleDelay?: number
  /** Whether a run is streaming (many sets); the long `delay` applies then. */
  busy?: () => boolean
}

/**
 * Wraps a Zustand `PersistStorage` so writes leave the click that caused them.
 *
 * Zustand persist calls `setItem` on every `set()`. For the Cowork sessions
 * store that meant serializing, parsing, redacting and serializing again the
 * whole session list synchronously (hundreds of ms with real history) on
 * every New session press. Here the latest value is kept and written once,
 * `delay` ms after the first change (`idleDelay` when nothing is streaming),
 * so a burst of sets (or a streaming run) costs one write. A pending write is
 * flushed when the page is hidden or closed, and on the desktop close path
 * (see `installExitFlush`), so nothing is lost on exit.
 */
export function deferredPersistStorage<S>(
  inner: PersistStorage<S>,
  delay = 1500,
  options: DeferredPersistOptions = {}
): PersistStorage<S> & { flush: () => Promise<void> } {
  const pending = new Map<string, StorageValue<S>>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const arm = (ms: number) => {
    if (!timer) timer = setTimeout(() => void flush(), ms)
  }

  const flush = async () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const writes = [...pending]
    pending.clear()
    await Promise.all(
      writes.map(async ([name, value]) => {
        try {
          await inner.setItem(name, value)
        } catch (e) {
          // Keep the value unless something newer arrived while it failed.
          if (!pending.has(name)) pending.set(name, value)
          console.error(`deferred write of '${name}' failed, will retry:`, e)
          arm(delay)
        }
      })
    )
  }

  flushers.add(flush)
  installExitFlush()

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
      const quiet = options.idleDelay !== undefined && !options.busy?.()
      arm(quiet ? options.idleDelay! : delay)
    },
    removeItem: (name) => {
      pending.delete(name)
      return inner.removeItem(name)
    },
    flush,
  }
}
