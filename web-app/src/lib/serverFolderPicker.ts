import { create } from 'zustand'

/**
 * The browser's stand-in for a native folder dialog: a chooser over the
 * folders `flint serve` allows (its `--agent-root` folders). `pickServerFolder`
 * opens it and resolves with the chosen path, or null when it is dismissed.
 * `ServerFolderPickerHost` renders it.
 */
type PickerState = {
  open: boolean
  resolve: ((path: string | null) => void) | null
  request: () => Promise<string | null>
  settle: (path: string | null) => void
}

export const useServerFolderPicker = create<PickerState>((set, get) => ({
  open: false,
  resolve: null,
  request: () =>
    new Promise<string | null>((resolve) => {
      // A second request supersedes one still open.
      get().resolve?.(null)
      set({ open: true, resolve })
    }),
  settle: (path) => {
    const resolve = get().resolve
    set({ open: false, resolve: null })
    resolve?.(path)
  },
}))

export function pickServerFolder(): Promise<string | null> {
  return useServerFolderPicker.getState().request()
}

/** A server path as a person reads it (Windows canonical paths carry `\\?\`). */
export function displayPath(path: string): string {
  return path.startsWith('\\\\?\\') ? path.slice(4) : path
}
