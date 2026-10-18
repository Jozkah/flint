/**
 * Whether the Tauri backend can answer: false on a page served to a browser
 * (`flint serve`), where every `invoke` would reject. The dev preview installs
 * a bridge of its own, so it counts as available.
 */
export const hasDesktopBackend = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
