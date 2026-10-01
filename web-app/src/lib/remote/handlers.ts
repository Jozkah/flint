// The phase-1 RPC handlers: read-only views of what the desktop already holds.
// Each reads through `RemoteSources`, so tests supply plain data and the app
// supplies its stores (see `appSources`).

import type { UIMessage } from 'ai'
import { RemoteRpcError, plannedHandlers, type RemoteHandlers } from './bridge'
import { createActionHandlers, type RemoteActions } from './actions'
import { handleMobileMutation } from './mobileMutations'
import { createExtraHandlers, type RemoteExtras } from './extras'
import { createStudioHandlers, type RemoteStudio, type RemoteVoice } from './studio'
import type {
  AppearanceResult,
  CoworkActivity,
  CoworkChanges,
  CoworkDetail,
  LibraryItem,
  NotificationPrefs,
  QueuedItem,
  StreamSnapshot,
  McpServerInfo,
  RemoteApproval,
  RoomDetail,
  SettingsSnapshot,
  SystemInfo,
  RemoteMessage,
  RemoteModel,
  SessionKind,
  SessionStatus,
  SessionSummary,
  ThreadMessagesParams,
} from './protocol'

export type ChatSource = {
  id: string
  title: string
  /** Seconds or milliseconds; both occur in stored threads. */
  updated: number
  project?: string
  pinned?: boolean
}
export type CoworkSource = {
  id: string
  title: string
  updated: number
  folder: string | null
}
export type RoomSource = {
  id: string
  title: string
  status: string
  updatedAt: number
}

export type RemoteSources = {
  chats: () => ChatSource[]
  coworkSessions: () => CoworkSource[]
  rooms: () => Promise<RoomSource[]>
  /** Ids with a run in flight, per kind. */
  running: () => Record<SessionKind, ReadonlySet<string>>
  /** Pending approval prompts, by the conversation they belong to. */
  approvals: () => { requestId: string; threadId: string }[]
  chatMessages: (id: string) => Promise<RemoteMessage[]>
  coworkMessages: (id: string) => RemoteMessage[] | null
  roomMessages: (id: string) => Promise<RemoteMessage[]>
  providers: () => {
    provider: string
    title?: string
    local: boolean
    models: { id: string; name?: string }[]
  }[]
  loadedModels: () => Promise<string[]>
  /** Ids starred in the model picker. */
  favoriteModels?: () => string[]
  roomDetail: (id: string) => Promise<RoomDetail | null>
  coworkDetail: (id: string) => CoworkDetail | null
  approvalDetails: () => RemoteApproval[]
  systemInfo: () => Promise<SystemInfo>
  mcpServers: () => McpServerInfo[]
  settings: () => Promise<SettingsSnapshot>
  appearance: () => AppearanceResult
  streamSnapshot?: (kind: SessionKind, id: string) => StreamSnapshot | null
  queue?: (id: string) => QueuedItem[]
  coworkChanges?: (id: string) => CoworkChanges | null
  coworkActivity?: (id: string) => CoworkActivity | null
  library?: () => LibraryItem[]
  permissions?: () => Promise<{ approvals: boolean; alwaysAllow: boolean } | null>
  notificationPrefs?: (device: string) => NotificationPrefs | null
}

export const DEFAULT_PAGE = 50
export const MAX_PAGE = 200

const toMs = (t: number) => (t < 1e12 ? Math.round(t * 1000) : t)
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export function roomStatus(s: string): SessionStatus {
  switch (s) {
    case 'running': return 'running'
    case 'awaiting-user': return 'waiting'
    case 'paused': return 'paused'
    case 'draft': return 'idle'
    default: return 'done'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_PAGE
  return Math.min(Math.max(n, 1), MAX_PAGE)
}

const KINDS: readonly SessionKind[] = ['chat', 'cowork', 'room']

function requireId(params: unknown): string {
  const id = isRecord(params) ? params.id : undefined
  if (typeof id !== 'string' || !id) throw new RemoteRpcError('bad_params', 'id is required')
  return id
}

export function pageOf<T>(all: T[], before: number | undefined, limit: number) {
  const end = before === undefined ? all.length : Math.min(Math.max(0, before), all.length)
  const start = Math.max(0, end - limit)
  return { items: all.slice(start, end), start, total: all.length }
}

export function uiMessageText(m: UIMessage): string {
  return (m.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

function need<T>(fn: T | undefined, what: string): T {
  if (!fn) throw new RemoteRpcError('not_implemented', `${what} is not available from phones yet`)
  return fn
}

export function createRemoteHandlers(
  src: RemoteSources,
  actions?: RemoteActions,
  extras?: RemoteExtras,
  studio?: RemoteStudio,
  voice?: RemoteVoice
): RemoteHandlers {
  const actionHandlers = actions ? createActionHandlers(actions) : undefined
  return {
    ...plannedHandlers,
    ...createExtraHandlers(extras),
    ...createStudioHandlers(studio, voice),
    ...(actionHandlers ?? {}),

    // First-class Room mutations. These deliberately reuse the exact Room
    // controller/persistence path used by the desktop and do not grant any
    // filesystem permissions.
    'room.create': async (params) => {
      const result = await handleMobileMutation({ mobileOp: 'room.create', input: params })
      if (!result || typeof result.id !== 'string') throw new RemoteRpcError('internal', 'Room could not be created')
      return { ok: true, id: result.id }
    },
    'room.update': async (params) => {
      const result = await handleMobileMutation({ mobileOp: 'room.update', id: params.id, patch: params.patch })
      if (!result || typeof result.id !== 'string') throw new RemoteRpcError('internal', 'Room could not be updated')
      return { ok: true, id: result.id }
    },
    'room.delete': async (params) => {
      const result = await handleMobileMutation({ mobileOp: 'room.delete', id: params.id })
      if (!result) throw new RemoteRpcError('internal', 'Room could not be deleted')
      return { ok: true }
    },

    // Legacy safe mobile mutations for chat/Cowork menus. These do not widen
    // permissions; Room mutations no longer travel through settings.set.
    'settings.set': async (params, ctx) => {
      if (isRecord(params) && 'mobileOp' in params && typeof params.mobileOp === 'string') {
        const result = await handleMobileMutation(params)
        if (!result) throw new RemoteRpcError('bad_params', 'Unknown mobile operation')
        return { ok: true }
      }
      if (!actionHandlers) throw new RemoteRpcError('not_implemented', 'Changing settings is not available from phones yet')
      return actionHandlers['settings.set'](params, ctx)
    },

    'stream.get': (params) => {
      const p = (isRecord(params) ? params : {}) as { kind?: unknown; id?: unknown }
      if (typeof p.id !== 'string' || !p.id || !KINDS.includes(p.kind as SessionKind)) {
        throw new RemoteRpcError('bad_params', 'id and kind are required')
      }
      return need(src.streamSnapshot, 'Following a reply')(p.kind as SessionKind, p.id)
    },

    'thread.queue': (params) => ({ items: need(src.queue, 'The queue')(requireId(params)) }),

    'cowork.changes': (params) => {
      const changes = need(src.coworkChanges, 'Changes')(requireId(params))
      if (!changes) throw new RemoteRpcError('not_found', 'No such session')
      return changes
    },

    'cowork.activity': (params) => {
      const activity = need(src.coworkActivity, 'Activity')(requireId(params))
      if (!activity) throw new RemoteRpcError('not_found', 'No such session')
      return activity
    },

    'library.list': () => ({ items: need(src.library, 'The library')() }),

    'sessions.list': async (params) => {
      const p = isRecord(params) ? params : {}
      const kind = KINDS.includes(p.kind as SessionKind) ? (p.kind as SessionKind) : undefined
      const limit = clampLimit(p.limit)
      const running = src.running()
      const waiting = new Set(src.approvals().map((a) => a.threadId))
      const status = (k: SessionKind, id: string): SessionStatus =>
        waiting.has(id) ? 'waiting' : running[k].has(id) ? 'running' : 'idle'

      const out: SessionSummary[] = []
      if (!kind || kind === 'chat') {
        for (const c of src.chats()) {
          out.push({
            id: c.id,
            kind: 'chat',
            title: c.title,
            status: status('chat', c.id),
            updatedAt: toMs(c.updated),
            ...(c.project ? { group: c.project } : {}),
            ...(c.pinned ? { pinned: true } : {}),
          })
        }
      }
      if (!kind || kind === 'cowork') {
        for (const s of src.coworkSessions()) {
          out.push({
            id: s.id,
            kind: 'cowork',
            title: s.title,
            status: status('cowork', s.id),
            updatedAt: toMs(s.updated),
            ...(s.folder ? { group: basename(s.folder) } : {}),
          })
        }
      }
      if (!kind || kind === 'room') {
        for (const r of await src.rooms()) {
          out.push({
            id: r.id,
            kind: 'room',
            title: r.title,
            status: running.room.has(r.id) ? 'running' : roomStatus(r.status),
            updatedAt: toMs(r.updatedAt),
          })
        }
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt)
      return { sessions: out.slice(0, limit) }
    },

    'thread.messages': async (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<ThreadMessagesParams>
      if (typeof p.id !== 'string' || !p.id || !KINDS.includes(p.kind as SessionKind)) {
        throw new RemoteRpcError('bad_params', 'id and kind are required')
      }
      let all: RemoteMessage[] | null
      if (p.kind === 'chat') all = await src.chatMessages(p.id)
      else if (p.kind === 'cowork') all = src.coworkMessages(p.id)
      else all = await src.roomMessages(p.id)
      if (!all) throw new RemoteRpcError('not_found', 'No such conversation')
      const before = typeof p.before === 'number' ? p.before : undefined
      const { items, start, total } = pageOf(all, before, clampLimit(p.limit))
      return { messages: items, start, total }
    },

    'models.list': async () => {
      const loaded = new Set(await src.loadedModels())
      const favorites = new Set(src.favoriteModels?.() ?? [])
      const models: RemoteModel[] = []
      for (const prov of src.providers()) {
        for (const m of prov.models) {
          models.push({
            id: m.id,
            name: m.name || m.id,
            provider: prov.provider,
            ...(prov.title ? { providerName: prov.title } : {}),
            local: prov.local,
            loaded: loaded.has(m.id),
            ...(favorites.has(m.id) ? { favorite: true } : {}),
          })
        }
      }
      return { models }
    },

    'rooms.get': async (params) => {
      const room = await src.roomDetail(requireId(params))
      if (!room) throw new RemoteRpcError('not_found', 'No such room')
      return src.running().room.has(room.id) ? { ...room, status: 'running' } : room
    },

    'cowork.get': (params) => {
      const id = requireId(params)
      const detail = src.coworkDetail(id)
      if (!detail) throw new RemoteRpcError('not_found', 'No such session')
      const waiting = src.approvals().some((a) => a.threadId === id)
      const running = src.running().cowork.has(id)
      return { ...detail, status: waiting ? 'waiting' : running ? 'running' : detail.status }
    },

    'approvals.list': () => ({ approvals: src.approvalDetails() }),
    'system.info': () => src.systemInfo(),
    'tools.list': () => ({ servers: src.mcpServers() }),

    'settings.get': async (_params, ctx) => {
      const snapshot = await src.settings()
      const prefs = src.notificationPrefs?.(ctx.device.id)
      return prefs ? { ...snapshot, notifications: prefs } : snapshot
    },

    'appearance.get': () => src.appearance(),

    status: async () => {
      const running = src.running()
      const runs = KINDS.flatMap((kind) => [...running[kind]].map((id) => ({ kind, id })))
      const permissions = await src.permissions?.().catch(() => null)
      return {
        modelsLoaded: (await src.loadedModels()).length,
        runs,
        approvalsWaiting: src.approvals().length,
        ...(permissions ? { permissions } : {}),
      }
    },
  }
}
