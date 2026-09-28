// The phone app's state and the actions screens call. One runtime (client +
// event socket) per page; tests install their own with `installRuntime`.

import type {
  RemoteEvent,
  RemoteMethod,
  RemoteMethods,
  SessionKind,
} from '@/lib/remote/protocol'
import { RemoteCallError, type Me, type RemoteClient } from '../api/client'
import type { ConnectionState, EventSocket } from '../api/events'
import { createStore } from './store'
import { hashToRoute, routeToHash, type HomeMode, type Route } from './router'
import { invalidate } from './rpc'

export type Notice = {
  id: string
  kind: 'approval' | 'run' | 'room' | 'info'
  title: string
  body: string
  at: number
  route?: Route
  unread: boolean
  /** An approval the banner can answer in place. */
  requestId?: string
}

export type ThemePref = 'system' | 'light' | 'dark'

export type ComposerModel = { id: string; provider: string; name: string }

export type AppState = {
  auth: 'checking' | 'paired' | 'unpaired' | 'pairing'
  pairing: { code: string; computer?: string } | null
  conn: ConnectionState
  route: Route
  drawer: 'left' | 'right' | null
  rightTab: string | null
  sheet: { name: string; props?: Record<string, unknown> } | null
  toast: { id: number; text: string } | null
  push: Notice | null
  notices: Notice[]
  me: Me | null
  computerName: string | null
  theme: ThemePref
  homeMode: HomeMode
  composer: {
    model: ComposerModel | null
    web: boolean
    reason: 'auto' | 'on' | 'off'
    budget: string
    cwMode: 'review' | 'ask' | 'auto'
    access: 'review-only' | 'managed-worktree' | 'edit-folder'
  }
}

const THEME_KEY = 'flint-remote-theme'

function readTheme(): ThemePref {
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export const initialState = (): AppState => ({
  auth: 'checking',
  pairing: null,
  conn: 'offline',
  route: typeof location !== 'undefined' ? hashToRoute(location.hash) : { name: 'home' },
  drawer: null,
  rightTab: null,
  sheet: null,
  toast: null,
  push: null,
  notices: [],
  me: null,
  computerName: null,
  theme: readTheme(),
  homeMode: 'chat',
  composer: {
    model: null,
    web: true,
    reason: 'auto',
    budget: 'Unlimited',
    cwMode: 'ask',
    access: 'managed-worktree',
  },
})

export const app = createStore<AppState>(initialState())
export const useApp = app.use

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

type Runtime = { client: RemoteClient; socket: EventSocket | null }
let runtime: Runtime | null = null

export function installRuntime(r: Runtime) {
  runtime = r
}

export function client(): RemoteClient {
  if (!runtime) throw new Error('remote runtime not installed')
  return runtime.client
}

export function socket(): EventSocket | null {
  return runtime?.socket ?? null
}

// ---------------------------------------------------------------------------
// Navigation, drawers, sheets, toasts
// ---------------------------------------------------------------------------

let depth = 0

export function go(route: Route) {
  closeAll()
  if (route.name === 'home' && route.mode) app.set({ homeMode: route.mode })
  const hash = routeToHash(route)
  app.set({ route })
  if (typeof location !== 'undefined' && location.hash !== hash) {
    depth++
    history.pushState(null, '', hash)
  }
  if (route.name === 'notifications') markNoticesRead()
}

export function back() {
  closeAll()
  if (depth > 0 && typeof history !== 'undefined') {
    depth--
    history.back()
  } else {
    go({ name: 'home' })
  }
}

/** Keeps the state in step with the hash (back gesture, manual edits). */
export function syncRouteFromHash() {
  if (typeof location === 'undefined') return
  if (location.hash.startsWith('#pair=')) return
  app.set({ route: hashToRoute(location.hash), drawer: null, sheet: null })
}

export function openDrawer(side: 'left' | 'right', tab?: string) {
  app.set({ drawer: side, sheet: null, ...(tab ? { rightTab: tab } : {}) })
}

export function closeAll() {
  app.set({ drawer: null, sheet: null })
}

export function openSheet(name: string, props?: Record<string, unknown>) {
  app.set({ sheet: { name, props } })
}

export function closeSheet() {
  app.set({ sheet: null })
}

let toastId = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function toast(text: string) {
  const id = ++toastId
  app.set({ toast: { id, text } })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (app.get().toast?.id === id) app.set({ toast: null })
  }, 2600)
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export function setTheme(theme: ThemePref) {
  try {
    if (theme === 'system') globalThis.localStorage?.removeItem(THEME_KEY)
    else globalThis.localStorage?.setItem(THEME_KEY, theme)
  } catch {
    // Kept for this visit only.
  }
  app.set({ theme })
}

// ---------------------------------------------------------------------------
// Calls that change something on the computer
// ---------------------------------------------------------------------------

const LATER: Partial<Record<RemoteMethod, string>> = {
  'chat.send': 'Sending from the phone',
  'cowork.send': 'Sending from the phone',
  'room.send': 'Writing to a room from the phone',
  'run.stop': 'Stopping runs from the phone',
  'approvals.respond': 'Answering approvals from the phone',
  'settings.set': 'Changing settings from the phone',
}

/** Why a call failed, in words for a toast. */
export function describeError(method: RemoteMethod, e: unknown): string {
  if (e instanceof RemoteCallError) {
    if (e.code === 'not_implemented') return `${LATER[method] ?? 'This'} comes in a later update`
    if (e.code === 'forbidden') return e.message
    if (e.code === 'network') return "Can't reach your computer"
    if (e.code === 'unavailable') return "Flint's window isn't open on your computer"
    if (e.code === 'timeout') return "Your computer didn't answer in time"
    if (e.code === 'unauthorized') return "This phone isn't paired"
    return e.message
  }
  return 'Something went wrong'
}

/** Calls a method that acts on the computer. The desktop's answer is shown
 * as is: a refusal (including `not_implemented`) becomes a toast and never
 * looks like success. */
export async function act<M extends RemoteMethod>(
  method: M,
  params: RemoteMethods[M]['params'],
  success?: string
): Promise<RemoteMethods[M]['result'] | undefined> {
  try {
    const result = await client().rpc(method, params)
    if (success) toast(success)
    return result
  } catch (e) {
    toast(describeError(method, e))
    return undefined
  }
}

/** For controls with no RPC yet (rename, delete, export ...). */
export function notYet(what = 'This') {
  toast(`${what} isn't available from the phone yet`)
}

// ---------------------------------------------------------------------------
// Events from the computer
// ---------------------------------------------------------------------------

let noticeSeq = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null

export function addNotice(n: Omit<Notice, 'id' | 'at' | 'unread'>, push = true) {
  const notice: Notice = { ...n, id: `n${++noticeSeq}`, at: Date.now(), unread: true }
  app.set((s) => ({ notices: [notice, ...s.notices].slice(0, 100) }))
  if (push && app.get().route.name !== 'notifications') {
    app.set({ push: notice })
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      if (app.get().push?.id === notice.id) app.set({ push: null })
    }, n.kind === 'approval' ? 9000 : 5000)
  }
}

export function markNoticesRead() {
  app.set((s) => ({ notices: s.notices.map((n) => (n.unread ? { ...n, unread: false } : n)) }))
}

const KIND_WORD: Record<SessionKind, string> = { chat: 'Chat', cowork: 'Cowork', room: 'Room' }

export function handleEvent(e: RemoteEvent) {
  switch (e.type) {
    case 'approval.requested':
      invalidate(['approvals.list', 'status', 'sessions.list', 'cowork.get'])
      addNotice({
        kind: 'approval',
        title: 'Approval waiting',
        body: `Flint wants to use ${e.toolName}`,
        route: { name: 'cowork', id: e.threadId },
        requestId: e.requestId,
      })
      break
    case 'approval.resolved':
      invalidate(['approvals.list', 'status', 'sessions.list', 'cowork.get'])
      break
    case 'run.started':
      invalidate(['status', 'sessions.list', `${e.kind === 'room' ? 'rooms' : e.kind}.get`])
      break
    case 'run.finished':
      invalidate(['status', 'sessions.list', 'thread.messages', 'cowork.get', 'rooms.get'])
      addNotice(
        {
          kind: e.kind === 'room' ? 'room' : 'run',
          title: `${KIND_WORD[e.kind]} run finished`,
          body: 'Open it to see the result.',
          route: { name: e.kind, id: e.id },
        },
        e.kind !== 'chat'
      )
      break
    case 'notification':
      addNotice({ kind: 'info', title: e.title, body: e.body })
      break
  }
}
