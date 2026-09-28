// The phase-1 RPC handlers: read-only views of what the desktop already holds.
// Each reads through `RemoteSources`, so tests supply plain data and the app
// supplies its stores (see `appSources`).

import type { UIMessage } from 'ai'
import { RemoteRpcError, plannedHandlers, type RemoteHandlers } from './bridge'
import type {
  AppearanceResult,
  CoworkDetail,
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
}

export const DEFAULT_PAGE = 50
export const MAX_PAGE = 200

const toMs = (t: number) => (t < 1e12 ? Math.round(t * 1000) : t)

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export function roomStatus(s: string): SessionStatus {
  switch (s) {
    case 'running':
      return 'running'
    case 'awaiting-user':
      return 'waiting'
    case 'paused':
      return 'paused'
    case 'draft':
      return 'idle'
    default:
      return 'done'
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

/** A page of `all`, ending before index `before` (default: the end). */
export function pageOf<T>(all: T[], before: number | undefined, limit: number) {
  const end = before === undefined ? all.length : Math.min(Math.max(0, before), all.length)
  const start = Math.max(0, end - limit)
  return { items: all.slice(start, end), start, total: all.length }
}

/** Plain text of a Cowork UI message: its text parts, joined. */
export function uiMessageText(m: UIMessage): string {
  return (m.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function createRemoteHandlers(src: RemoteSources): RemoteHandlers {
  return {
    ...plannedHandlers,

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

    'settings.get': () => src.settings(),

    'appearance.get': () => src.appearance(),

    status: async () => {
      const running = src.running()
      const runs = KINDS.flatMap((kind) => [...running[kind]].map((id) => ({ kind, id })))
      return {
        modelsLoaded: (await src.loadedModels()).length,
        runs,
        approvalsWaiting: src.approvals().length,
      }
    },
  }
}
