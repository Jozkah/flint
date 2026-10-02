// RPC handlers for what the desktop gained in #30–#87: the chat's details
// (context window, effort, "What Flint is using"), assistants, fork and title
// regeneration, clearing a room, the Cowork Code and Preview tabs (read-only),
// and Hugging Face browsing and downloads. Each one validates its params here
// and calls `RemoteExtras`, which the app implements over its own stores and
// tests implement with plain data.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import type {
  AssistantsResult,
  ChatDetails,
  CoworkFileResult,
  CoworkFilesResult,
  CoworkPreviewResult,
  DownloadTaskWire,
  EffortChoiceWire,
  HfSearchParams,
  HfSearchResult,
  RoomClearParams,
  SessionKind,
  TitleRegenerateResult,
} from './protocol'

export type RemoteExtras = {
  chatDetails(id: string): Promise<ChatDetails | null> | ChatDetails | null
  /** `null` resets to the model's default (the desktop's Reset). */
  setChatEffort(id: string, choice: EffortChoiceWire | null): void
  /** `auto` puts the chat back on Flint, which Jev may route. */
  setChatAssistant(id: string, assistant: string): void
  assistants(): AssistantsResult
  forkChat(id: string, messageId?: string): Promise<string | null>
  /** Step a message's version; false when there is none that way or the chat is busy. */
  selectVersion(id: string, messageId: string, dir: -1 | 1): boolean
  compactChat(id: string): boolean
  regenerateTitle(kind: SessionKind, id: string): Promise<TitleRegenerateResult['result']>
  clearRoom(id: string, scope: RoomClearParams['scope']): Promise<void>
  coworkFiles(id: string, path: string): Promise<CoworkFilesResult | null>
  coworkFile(id: string, path: string): Promise<CoworkFileResult | null>
  coworkPreview(id: string, path?: string): Promise<CoworkPreviewResult | null>
  hfSearch(params: HfSearchParams): Promise<HfSearchResult>
  hfDownload(repo: string, quant?: string): Promise<string>
  downloads(): DownloadTaskWire[]
}

export type ExtraMethods =
  | 'chat.details'
  | 'chat.effort'
  | 'chat.assistant'
  | 'chat.fork'
  | 'thread.branch.select'
  | 'chat.compact'
  | 'title.regenerate'
  | 'assistants.list'
  | 'room.clear'
  | 'cowork.files'
  | 'cowork.file'
  | 'cowork.preview'
  | 'hf.search'
  | 'hf.download'
  | 'models.downloads'

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

function id(params: unknown): string {
  const v = str(rec(params).id)
  if (!v) throw new RemoteRpcError('bad_params', 'id is required')
  return v
}

/** A relative path inside a project: no absolute paths, no climbing out. */
export function safeRelPath(raw: unknown): string {
  const p = str(raw).replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p) return ''
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..')) {
    throw new RemoteRpcError('forbidden', 'That path is outside the session folder')
  }
  return p
}

const EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh']
const KINDS: readonly string[] = ['chat', 'cowork', 'room']
const CLEAR: readonly string[] = ['chat', 'knowledge', 'everything']
const MODALITIES: readonly string[] = ['all', 'text', 'vision', 'audio', 'code', 'embeddings']

export function createExtraHandlers(x?: RemoteExtras): Pick<RemoteHandlers, ExtraMethods> {
  const need = (): RemoteExtras => {
    if (!x) throw new RemoteRpcError('not_implemented', 'This is not available from phones yet')
    return x
  }
  return {
    'chat.details': async (params) => {
      const d = await need().chatDetails(id(params))
      if (!d) throw new RemoteRpcError('not_found', 'No such chat')
      return d
    },
    'chat.effort': (params) => {
      const p = rec(params)
      const choice = p.choice === null ? null : str(p.choice)
      if (choice !== null && !EFFORTS.includes(choice)) throw new RemoteRpcError('bad_params', 'Unknown effort')
      need().setChatEffort(id(params), choice as EffortChoiceWire | null)
      return { ok: true }
    },
    'chat.assistant': (params) => {
      const assistant = str(rec(params).assistant)
      if (!assistant) throw new RemoteRpcError('bad_params', 'assistant is required')
      const known = need().assistants().assistants.some((a) => a.id === assistant)
      if (assistant !== 'auto' && !known) throw new RemoteRpcError('not_found', 'No such assistant')
      need().setChatAssistant(id(params), assistant)
      return { ok: true }
    },
    'assistants.list': () => need().assistants(),
    'chat.fork': async (params) => {
      const messageId = str(rec(params).messageId) || undefined
      const next = await need().forkChat(id(params), messageId)
      if (!next) throw new RemoteRpcError('bad_params', 'There is nothing to fork in this chat')
      return { id: next }
    },
    'thread.branch.select': (params) => {
      const p = rec(params)
      const messageId = str(p.messageId)
      if (!messageId) throw new RemoteRpcError('bad_params', 'messageId is required')
      if (p.dir !== -1 && p.dir !== 1) throw new RemoteRpcError('bad_params', 'dir must be -1 or 1')
      return { ok: need().selectVersion(id(params), messageId, p.dir) }
    },
    'chat.compact': (params) => ({ started: need().compactChat(id(params)) }),
    'title.regenerate': async (params) => {
      const kind = str(rec(params).kind)
      if (!KINDS.includes(kind)) throw new RemoteRpcError('bad_params', 'kind is required')
      return { result: await need().regenerateTitle(kind as SessionKind, id(params)) }
    },
    'room.clear': async (params) => {
      const scope = str(rec(params).scope)
      if (!CLEAR.includes(scope)) throw new RemoteRpcError('bad_params', 'Unknown scope')
      await need().clearRoom(id(params), scope as RoomClearParams['scope'])
      return { ok: true }
    },
    'cowork.files': async (params) => {
      const r = await need().coworkFiles(id(params), safeRelPath(rec(params).path))
      if (!r) throw new RemoteRpcError('not_found', 'No such session')
      return r
    },
    'cowork.file': async (params) => {
      const path = safeRelPath(rec(params).path)
      if (!path) throw new RemoteRpcError('bad_params', 'path is required')
      const r = await need().coworkFile(id(params), path)
      if (!r) throw new RemoteRpcError('not_found', 'No such session')
      return r
    },
    'cowork.preview': async (params) => {
      const raw = rec(params).path
      const r = await need().coworkPreview(id(params), raw === undefined ? undefined : safeRelPath(raw) || undefined)
      if (!r) throw new RemoteRpcError('not_found', 'No such session')
      return r
    },
    'hf.search': (params) => {
      const p = rec(params)
      const modality = str(p.modality) || 'all'
      if (!MODALITIES.includes(modality)) throw new RemoteRpcError('bad_params', 'Unknown modality')
      return need().hfSearch({ query: str(p.query).slice(0, 200), modality: modality as HfSearchParams['modality'] })
    },
    'hf.download': async (params) => {
      const p = rec(params)
      const repo = str(p.repo)
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new RemoteRpcError('bad_params', 'repo must be owner/name')
      return { ok: true, id: await need().hfDownload(repo, str(p.quant) || undefined) }
    },
    'models.downloads': () => ({ tasks: need().downloads() }),
  }
}
