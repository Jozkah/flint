import type { StateStorage } from 'zustand/middleware'
import { isPlatformTauri } from '@/lib/platform/utils'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * Async Zustand `StateStorage` backed by the Rust settings store
 * (`settings_get`/`settings_set`/`settings_remove`), which persists to
 * `<jan_data>/settings.json`. This keeps user settings off webview
 * localStorage so out-of-process consumers (jan-cli) can read them.
 *
 * On web (`dev:web`, no Tauri shell) there is no backend, so it degrades to
 * localStorage. The async boundary is honest: stores using this must set
 * `skipHydration: true` and be rehydrated via `hydrateBackendStores()` only
 * after the ServiceHub is initialized (`getServiceHub()` throws before that).
 */
// Last value handed to the backend (or read from it), per key. Lets setItem
// skip the serialization + IPC round-trip when Zustand persist re-writes an
// unchanged blob (it fires setItem on every set(), without diffing). It is
// recorded when a write is REQUESTED, not when it lands: recording on
// completion let a quick A -> B -> A sequence skip the second A (it still
// equalled the old confirmed value while B was in flight), so B stayed on disk
// while the state said A. A failed write forgets the value so the next call
// retries.
const lastWritten = new Map<string, string>()
// Writes of one key run one after another, so the last request is the last
// value the backend sees.
const inFlight = new Map<string, Promise<void>>()
// Keys whose read from the backend failed. Zustand persist treats a failed
// read as "nothing saved" and would write its defaults over the real file, so
// writes to these keys are refused until a read succeeds.
const failedReads = new Set<string>()

/** Keys the backend could not be read for; startup stops on any (never runs on defaults). */
export const backendReadFailures = (): string[] => [...failedReads]

export const backendStorage: StateStorage = {
  getItem: async (name) => {
    if (!isPlatformTauri()) return localStorage.getItem(name)
    try {
      const value = await getServiceHub().core().invoke<string | null>(
        'settings_get',
        { key: name }
      )
      failedReads.delete(name)
      if (value != null) lastWritten.set(name, value)
      return value ?? null
    } catch (error) {
      console.error(`settings_get failed for '${name}':`, error)
      failedReads.add(name)
      return null
    }
  },
  setItem: async (name, value) => {
    if (!isPlatformTauri()) {
      localStorage.setItem(name, value)
      return
    }
    if (failedReads.has(name)) return
    if (lastWritten.get(name) === value) return inFlight.get(name)
    lastWritten.set(name, value)
    const write = (inFlight.get(name) ?? Promise.resolve()).then(async () => {
      try {
        await getServiceHub().core().invoke('settings_set', { key: name, value })
      } catch (error) {
        if (lastWritten.get(name) === value) lastWritten.delete(name)
        console.error(`settings_set failed for '${name}':`, error)
      }
    })
    inFlight.set(name, write)
    await write
  },
  removeItem: async (name) => {
    if (!isPlatformTauri()) {
      localStorage.removeItem(name)
      return
    }
    try {
      await inFlight.get(name)
      await getServiceHub().core().invoke('settings_remove', { key: name })
      lastWritten.delete(name)
    } catch (error) {
      console.error(`settings_remove failed for '${name}':`, error)
    }
  },
}
