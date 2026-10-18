/**
 * Fired on `window` when every extension's `onLoad` has settled. The UI can
 * mount before that when setup is slow (the setup watchdog), and anything it
 * read from an extension in the meantime may predate first-run seeding.
 */
export const EXTENSIONS_LOADED_EVENT = 'flint:extensions-loaded'

let extensionsLoaded = false

/** Latch: set once, so a listener that subscribes after the event still knows. */
export function markExtensionsLoaded(): void {
  extensionsLoaded = true
  window.dispatchEvent(new Event(EXTENSIONS_LOADED_EVENT))
}

export function areExtensionsLoaded(): boolean {
  return extensionsLoaded
}

/**
 * Resolves when extension loading has settled: at once if it already has (the
 * event may have fired before the caller subscribed), else on the event.
 */
export function whenExtensionsLoaded(): Promise<void> {
  if (extensionsLoaded) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener(EXTENSIONS_LOADED_EVENT, done)
      resolve()
    }
    window.addEventListener(EXTENSIONS_LOADED_EVENT, done)
  })
}

/** Test seam. */
export function resetExtensionsLoaded(): void {
  extensionsLoaded = false
}
