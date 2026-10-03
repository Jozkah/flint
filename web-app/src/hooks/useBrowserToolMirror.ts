import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { BROWSER_TOOL_EVENT } from '@/lib/browserTool'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'

/**
 * A read-only mirror of what the agent's `browser` tool is doing.
 *
 * The agent drives a separate, throwaway, confined browser. This store only
 * ever holds what the backend *reports* about it -- address, title, the last
 * action, and a small picture -- and the panel that shows it renders that
 * picture. Nothing here loads the page, scripts any webview, or reaches the
 * agent's browser, so the user can watch without the page getting anywhere
 * near Flint's own preview or profile.
 */

/** What the backend announces (`browser::session::Activity`, camelCase). */
export type BrowserToolActivity = {
  sessionId: string
  runId: string
  kind: 'open' | 'action' | 'screenshot' | 'closed'
  action: string
  url: string
  title: string
  screenshot: string | null
}

export type BrowserToolView = {
  url: string
  title: string
  action: string
  screenshot: string | null
  updatedAt: number
}

/** The backend caps the picture at about 300 KiB of JPEG; refuse more here too. */
const MAX_SCREENSHOT_CHARS = 450_000
const MAX_FIELD = 400

const clip = (s: unknown, n = MAX_FIELD): string =>
  typeof s === 'string' ? s.slice(0, n) : ''

function safeShot(s: unknown): string | null {
  return typeof s === 'string' &&
    s.startsWith('data:image/jpeg;base64,') &&
    s.length <= MAX_SCREENSHOT_CHARS
    ? s
    : null
}

type ListenFn = (
  event: string,
  handler: (e: { payload: unknown }) => void
) => Promise<() => void>

const defaultListen: ListenFn = async (event, handler) => {
  const { listen } = await import('@tauri-apps/api/event')
  return listen(event, handler as never)
}

type Deps = {
  listen?: ListenFn
  watch?: (watching: boolean) => Promise<unknown>
  /** Whether the user has the in-app preview on. */
  enabled?: () => boolean
  now?: () => number
}

type MirrorState = {
  /** The agent's browser as last reported, per conversation or session. */
  byId: Record<string, BrowserToolView>
  apply: (activity: unknown, now?: number) => void
  clear: (sessionId?: string) => void
  /**
   * Start listening for the agent's browser notices (a few short strings; no
   * picture is taken for them). Returns the function that stops listening. A
   * no-op when the user has turned the in-app preview off.
   */
  attach: (deps?: Deps) => Promise<() => void>
  /**
   * Tell the backend a panel is showing the agent's browser, so it takes the
   * small pictures the panel displays. Counted: several panels may ask, and
   * the backend is told to stop only when the last one lets go. Returns the
   * release function. A no-op when the in-app preview is off.
   */
  watch: (deps?: Pick<Deps, 'watch' | 'enabled'>) => () => void
}

const defaultWatch = (watching: boolean) =>
  invoke('browser_tool_watch', { watching })

/** Panels currently showing the agent's browser. */
let watchers = 0

export const useBrowserToolMirror = create<MirrorState>()((set, get) => ({
  byId: {},
  apply: (raw, now = Date.now()) => {
    if (!raw || typeof raw !== 'object') return
    const a = raw as Partial<BrowserToolActivity>
    const id = clip(a.sessionId, 200)
    if (!id) return
    if (a.kind === 'closed') {
      get().clear(id)
      return
    }
    set((s) => {
      const prev = s.byId[id]
      const shot = safeShot(a.screenshot)
      return {
        byId: {
          ...s.byId,
          [id]: {
            url: clip(a.url, 300) || prev?.url || '',
            title: clip(a.title, 200) || prev?.title || '',
            action: clip(a.action, 200),
            // A looking action sends no new picture: keep the last one.
            screenshot: shot ?? prev?.screenshot ?? null,
            updatedAt: now,
          },
        },
      }
    })
  },
  clear: (sessionId) =>
    set((s) => {
      if (!sessionId) return { byId: {} }
      if (!(sessionId in s.byId)) return s
      const byId = { ...s.byId }
      delete byId[sessionId]
      return { byId }
    }),
  attach: async (deps = {}) => {
    const enabled = deps.enabled ?? (() => useWebPreviewSettings.getState().interceptLinks)
    if (!enabled()) return () => undefined
    let unlisten: (() => void) | undefined
    try {
      unlisten = await (deps.listen ?? defaultListen)(BROWSER_TOOL_EVENT, (e) =>
        get().apply(e.payload, deps.now?.())
      )
    } catch {
      // Not in the desktop app, or the backend is older: there is nothing to mirror.
    }
    return () => unlisten?.()
  },
  watch: (deps = {}) => {
    const enabled = deps.enabled ?? (() => useWebPreviewSettings.getState().interceptLinks)
    if (!enabled()) return () => undefined
    const tell = deps.watch ?? defaultWatch
    const send = (on: boolean) =>
      void Promise.resolve()
        .then(() => tell(on))
        .catch(() => undefined)
    if (watchers++ === 0) send(true)
    let released = false
    return () => {
      if (released) return
      released = true
      if (--watchers === 0) send(false)
    }
  },
}))
