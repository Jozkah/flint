// The phone app's state and the actions screens call. One runtime (client +
// event socket) per page; tests install their own with `installRuntime`.

import type {
  ApprovalRespondParams,
  ChatSendParams,
  CoworkSendParams,
  RemoteApproval,
  RemoteEvent,
  RemoteMethod,
  RemoteMethods,
  RoomSendParams,
  SendResult,
  SessionKind,
} from '@/lib/remote/protocol'
import { RemoteCallError, type Me, type RemoteClient } from '../api/client'
import type { ConnectionState, EventSocket } from '../api/events'
import { createStore } from './store'
import { hashToRoute, routeToHash, type HomeMode, type Route } from './router'
import { invalidate, peekRpc, refresh } from './rpc'
import {
  addPending,
  dropPending,
  dropStream,
  handleStreamEvent,
  live,
  markResolved,
  newClientId,
  setSnapshot,
  settlePending,
} from './live'

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
  /** Conversations this phone asked to compact, until the computer answers. */
  compacting: Record<string, true>
  /** The Code tab's open files per Cowork session, and the one shown. */
  code: Record<string, { open: string[]; active: string | null }>
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
  compacting: {},
  code: {},
  composer: {
    model: null,
    web: true,
    reason: 'auto',
    budget: 'Unlimited',
    cwMode: 'ask',
    // Other destinations need the computer's consent dialog.
    access: 'review-only',
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

/** In-app steps above the entry page; kept in history.state so gesture Back and reloads cannot drift it. */
function appDepth(): number {
  const d = typeof history !== 'undefined' ? (history.state as { d?: unknown } | null)?.d : 0
  return typeof d === 'number' && d > 0 ? d : 0
}

export function go(route: Route) {
  closeAll()
  if (route.name === 'home' && route.mode) app.set({ homeMode: route.mode })
  const hash = routeToHash(route)
  app.set({ route })
  if (typeof location !== 'undefined' && location.hash !== hash) {
    history.pushState({ d: appDepth() + 1 }, '', hash)
  }
  if (route.name === 'notifications') markNoticesRead()
}

/** Back within the app; on the first screen (nothing in-app to go back to) go to `fallback` instead of leaving the app. */
export function back(fallback: Route = { name: 'home' }) {
  closeAll()
  if (appDepth() > 0) {
    history.back()
  } else {
    go(fallback)
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
  'room.control': 'Controlling a room from the phone',
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
    if (e.code === 'desktop_only') return `${e.message}.`
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

const RETRYABLE = new Set(['network', 'timeout', 'unavailable'])
const MAX_ATTEMPTS = 3

/** Waits until the event socket is back (or `ms` pass). */
function whenConnected(ms: number): Promise<void> {
  if (app.get().conn === 'connected') return new Promise((r) => setTimeout(r, 400))
  return new Promise((resolve) => {
    const stop = app.subscribe(() => {
      if (app.get().conn === 'connected') {
        stop()
        clearTimeout(timer)
        resolve()
      }
    })
    const timer = setTimeout(() => {
      stop()
      resolve()
    }, ms)
  })
}

type SendMethod = 'chat.send' | 'cowork.send' | 'room.send'
type SendParams = Omit<ChatSendParams, 'clientId'> | Omit<CoworkSendParams, 'clientId'> | Omit<RoomSendParams, 'clientId'>

/**
 * Sends a message, shown at once as pending. One `clientId` per message: a
 * send that fails for want of a connection is retried with the same id, so
 * the computer sends it once however many attempts reach it. Returns the
 * computer's answer, or undefined (with a toast) when it did not take it.
 */
export async function sendMessage(
  method: SendMethod,
  params: SendParams,
  opts: { clientId?: string; retryDelayMs?: number } = {}
): Promise<SendResult | undefined> {
  const kind: SessionKind = method === 'chat.send' ? 'chat' : method === 'cowork.send' ? 'cowork' : 'room'
  const clientId = opts.clientId ?? newClientId()
  const target = 'id' in params && params.id ? params.id : 'new'
  if (!opts.clientId) addPending({ clientId, kind, id: target, text: params.text })
  let last: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = (await client().rpc(method, { ...params, clientId } as never)) as SendResult
      settlePending(clientId, result)
      if (result.delivery === 'queued') toast('Queued · sends when the current run ends')
      else if (result.delivery === 'steered') toast('Steering · goes to the run at its next step')
      invalidate(['sessions.list', 'thread.queue', 'status'])
      return result
    } catch (e) {
      last = e
      const code = e instanceof RemoteCallError ? e.code : ''
      if (!RETRYABLE.has(code) || attempt === MAX_ATTEMPTS - 1) break
      await whenConnected(opts.retryDelayMs ?? 8000)
    }
  }
  // A new conversation's text stays in the composer; nothing to show.
  if (target === 'new') dropPending(clientId)
  else settlePending(clientId, null)
  toast(describeError(method, last))
  return undefined
}

/** Tries a failed send again, under its original id. */
export function retrySend(p: { clientId: string; kind: SessionKind; id: string; text: string }) {
  const method: SendMethod = p.kind === 'chat' ? 'chat.send' : p.kind === 'cowork' ? 'cowork.send' : 'room.send'
  live.set((s) => ({
    pending: s.pending.map((x) => (x.clientId === p.clientId ? { ...x, status: 'sending' } : x)),
  }))
  return sendMessage(method, { id: p.id === 'new' ? undefined : p.id, text: p.text } as SendParams, { clientId: p.clientId })
}

/** Answers an approval; says so when the computer (or another phone)
 * answered it first. */
export async function respondApproval(
  a: Pick<RemoteApproval, 'requestId' | 'threadId'>,
  decision: ApprovalRespondParams['decision'],
  scope: NonNullable<ApprovalRespondParams['scope']> = 'once',
  label?: string
) {
  const words = label ?? (decision === 'deny' ? 'Denied' : 'Allowed once')
  const r = await act('approvals.respond', {
    requestId: a.requestId,
    decision,
    ...(decision === 'allow' ? { scope } : {}),
  })
  if (!r) return undefined
  if (r.status === 'gone') {
    markResolved(a.requestId, { by: 'computer', label: 'Answered from the computer', threadId: a.threadId })
    toast('Already answered from the computer')
  } else {
    markResolved(a.requestId, { by: 'phone', label: `${words} · from this phone`, threadId: a.threadId })
    toast(`${words} · from this phone`)
  }
  invalidate(['approvals.list', 'status', 'cowork.get', 'sessions.list'])
  return r
}

/** Asks for the reply being written in a conversation (opening it, or after
 * a gap or a reconnect). */
export async function syncStream(kind: SessionKind, id: string) {
  try {
    setSnapshot(id, await client().rpc('stream.get', { kind, id }))
  } catch {
    // The stored messages still show; the next event starts a new stream.
  }
}

/** Follows a conversation's events while a screen shows it: subscribes to
 * its topic and, now and after every reconnect, catches up. */
export function followThread(kind: SessionKind, id: string): () => void {
  const off = socket()?.follow(`thread:${id}`)
  void syncStream(kind, id)
  let was = app.get().conn
  const stop = app.subscribe(() => {
    const conn = app.get().conn
    if (conn === 'connected' && was !== 'connected') void syncStream(kind, id)
    was = conn
  })
  return () => {
    stop()
    off?.()
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

/** Cache-key prefix of one conversation's messages (params start with id). */
const threadKey = (id: string) => `thread.messages ${JSON.stringify({ id }).slice(0, -1)}`

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
    case 'approval.resolved': {
      // Answered on the computer (or another phone) while this phone showed it.
      const shown = peekRpc('approvals.list', {})?.approvals.find((a) => a.requestId === e.requestId)
      if (shown && !live.get().resolved[e.requestId]) {
        markResolved(e.requestId, { by: 'computer', label: 'Answered from the computer', threadId: shown.threadId })
      }
      if (app.get().push?.requestId === e.requestId) app.set({ push: null })
      invalidate(['approvals.list', 'status', 'sessions.list', 'cowork.get'])
      break
    }
    case 'stream.delta':
    case 'stream.tool':
    case 'stream.done': {
      const out = handleStreamEvent(e)
      if (out.gap) void syncStream(out.gap.kind, out.gap.id)
      if (e.type === 'stream.tool') invalidate([`cowork.changes`, 'cowork.activity'])
      if (out.finished) {
        const { id } = out.finished
        void refresh([threadKey(id), 'cowork.get', 'cowork.changes', 'cowork.activity', 'thread.queue', 'rooms.get']).then(() =>
          dropStream(id)
        )
      }
      break
    }
    case 'thread.updated':
      invalidate([
        'thread.queue',
        e.kind === 'room' ? 'rooms.get' : e.kind === 'cowork' ? 'cowork.get' : 'sessions.list',
        'chat.details',
      ])
      if (app.get().compacting[e.id]) {
        const compacting = { ...app.get().compacting }
        delete compacting[e.id]
        app.set({ compacting })
      }
      void refresh([threadKey(e.id)])
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
