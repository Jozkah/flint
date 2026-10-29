import type { PersistStorage, StorageValue } from 'zustand/middleware'

/** Events the desktop close handler and this module use to flush before exit. */
export const FLUSH_BEFORE_EXIT_EVENT = 'flush-before-exit'
export const FLUSH_BEFORE_EXIT_DONE_EVENT = 'flush-before-exit-done'

const flushers = new Set<() => Promise<void>>()

/** Write every deferred store's pending value now. Never rejects. */
export const flushDeferredStores = async (): Promise<void> => {
  await Promise.all([...flushers].map((f) => f()))
}

/**
 * Add a flusher that runs with the deferred stores (the desktop close path and
 * `flushDeferredStores`). Returns its removal.
 */
export const registerExitFlusher = (f: () => Promise<void>): (() => void) => {
  flushers.add(f)
  installExitFlush()
  return () => {
    flushers.delete(f)
  }
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
): PersistStorage<S> & {
  flush: () => Promise<void>
  /** Write what is pending, then drop the page listeners and the exit flusher. */
  dispose: () => Promise<void>
} {
  const pending = new Map<string, StorageValue<S>>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const arm = (ms: number) => {
    if (!timer) timer = setTimeout(() => void flush(), ms)
  }

  // Keys removed while a write may be in flight: a failed write must not
  // re-queue (resurrect) them.
  const tombstones = new Set<string>()

  const run = async () => {
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
          if (!pending.has(name) && !tombstones.has(name)) {
            pending.set(name, value)
            arm(delay)
          }
          console.error(`deferred write of '${name}' failed, will retry:`, e)
        }
      })
    )
  }

  // Flushes run one after another so an older snapshot can never land after a
  // newer one. `run` never rejects.
  let chain: Promise<void> = Promise.resolve()
  const flush = (): Promise<void> => (chain = chain.then(run, run))

  flushers.add(flush)
  installExitFlush()

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void flush()
  }
  const onPageHide = () => void flush()
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
  }

  const dispose = async () => {
    flushers.delete(flush)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
    await flush()
  }

  return {
    getItem: (name) =>
      pending.has(name)
        ? Promise.resolve(pending.get(name)!)
        : inner.getItem(name),
    setItem: (name, value) => {
      tombstones.delete(name)
      pending.set(name, value)
      const quiet = options.idleDelay !== undefined && !options.busy?.()
      arm(quiet ? options.idleDelay! : delay)
    },
    removeItem: async (name) => {
      pending.delete(name)
      tombstones.add(name)
      // Let any in-flight write land first so it cannot resurrect the key.
      await chain
      await inner.removeItem(name)
    },
    flush,
    dispose,
  }
}
