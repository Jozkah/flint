import { create } from 'zustand'
import { isPreviewableUrl } from '@/lib/webPreview'

export type PreviewSurface = 'side' | 'pip'

type WebPreviewState = {
  open: boolean
  surface: PreviewSurface
  history: string[]
  index: number
  url: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
  openUrl: (url: string) => void
  navigate: (url: string) => void
  replaceUrl: (url: string) => void
  /** Title the page in the native view reports; empty until it does. */
  pageTitle: string
  setPageTitle: (title: string) => void
  /** The open pane's box in CSS px (any surface); null while closed. */
  paneRect: { left: number; top: number; right: number; bottom: number } | null
  setPaneRect: (rect: WebPreviewState['paneRect']) => void
  close: () => void
  setSurface: (s: PreviewSurface) => void
  back: () => void
  forward: () => void
}

/**
 * Global state for the in-app web preview. Holds a small browsing history so
 * the toolbar can offer back/forward; `surface` is a per-session preference
 * kept across close/reopen. Non-http URLs are ignored, never shown.
 */
export const useWebPreview = create<WebPreviewState>((set, get) => ({
  open: false,
  surface: 'side',
  history: [],
  index: -1,
  url: () => {
    const { history, index } = get()
    return index >= 0 ? history[index] : ''
  },
  canGoBack: () => get().index > 0,
  canGoForward: () => get().index < get().history.length - 1,
  openUrl: (url) => {
    if (!isPreviewableUrl(url)) return
    set((s) => {
      const history = [...s.history.slice(0, s.index + 1), url]
      return { open: true, history, index: history.length - 1 }
    })
  },
  navigate: (url) => {
    if (!isPreviewableUrl(url)) return
    set((s) => {
      const history = [...s.history.slice(0, s.index + 1), url]
      return { history, index: history.length - 1 }
    })
  },
  // Redirects inside the native view rewrite the current entry instead of
  // growing the history.
  replaceUrl: (url) => {
    if (!isPreviewableUrl(url)) return
    set((s) => {
      if (s.index < 0) return {}
      const history = [...s.history]
      history[s.index] = url
      return { history }
    })
  },
  pageTitle: '',
  setPageTitle: (pageTitle) => set({ pageTitle }),
  paneRect: null,
  setPaneRect: (paneRect) =>
    set((s) => {
      const a = s.paneRect
      if (
        a === paneRect ||
        (a &&
          paneRect &&
          a.left === paneRect.left &&
          a.top === paneRect.top &&
          a.right === paneRect.right &&
          a.bottom === paneRect.bottom)
      )
        return {}
      return { paneRect }
    }),
  close: () => set({ open: false, paneRect: null }),
  setSurface: (surface) => set({ surface }),
  back: () => set((s) => ({ index: Math.max(0, s.index - 1) })),
  forward: () =>
    set((s) => ({ index: Math.min(s.history.length - 1, s.index + 1) })),
}))
