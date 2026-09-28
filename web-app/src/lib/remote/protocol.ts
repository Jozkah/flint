// The remote-access wire protocol, shared by the desktop bridge and the phone
// client. The desktop's Rust server (src-tauri/src/core/remote) forwards a
// phone's `POST /remote/v1/rpc` body to the window as a `remote://rpc` event
// and returns whatever the bridge answers; events travel the other way over
// the `/remote/v1/events` WebSocket.
//
// Kept free of app imports so the phone bundle can use it as is.

export const REMOTE_API_PREFIX = '/remote/v1'
export const REMOTE_WS_PROTOCOL = 'flint-remote.v1'
/** A WebSocket may authenticate with the subprotocol `flint-auth.<token>`. */
export const REMOTE_WS_AUTH_PREFIX = 'flint-auth.'

/** Tauri event names between the Rust server and the window. */
export const REMOTE_EVENT_RPC = 'remote://rpc'
export const REMOTE_EVENT_PAIRING_REQUEST = 'remote://pairing-request'
export const REMOTE_EVENT_DEVICES_CHANGED = 'remote://devices-changed'

export type RemoteErrorCode =
  | 'not_implemented'
  | 'bad_params'
  | 'not_found'
  | 'internal'
  | 'forbidden'
  | 'unknown_method'

export type RemoteError = { code: RemoteErrorCode | string; message: string }

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

export type SessionKind = 'chat' | 'cowork' | 'room'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'done'

export type SessionSummary = {
  id: string
  kind: SessionKind
  title: string
  status: SessionStatus
  /** Unix ms. */
  updatedAt: number
  /** Project, folder or other grouping label, when the session has one. */
  group?: string
}

export type SessionsListParams = { kind?: SessionKind; limit?: number }
export type SessionsListResult = { sessions: SessionSummary[] }

export type RemoteMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** Plain text of the message; rich parts come in later phases. */
  text: string
  /** Unix ms. */
  createdAt: number
  /** Room speaker, when the message is from a room. */
  author?: string
}

export type ThreadMessagesParams = {
  id: string
  kind: SessionKind
  /** Messages before this index (from the end). Omitted: the latest page. */
  before?: number
  limit?: number
}
export type ThreadMessagesResult = {
  messages: RemoteMessage[]
  /** Index of the first returned message, for the next `before`. */
  start: number
  total: number
}

export type RemoteModel = {
  id: string
  name: string
  provider: string
  local: boolean
  loaded: boolean
}
export type ModelsListResult = { models: RemoteModel[] }

export type StatusResult = {
  modelsLoaded: number
  runs: { kind: SessionKind; id: string }[]
  approvalsWaiting: number
}

/** Every method a phone may call, with its params and result. */
export type RemoteMethods = {
  'sessions.list': { params: SessionsListParams; result: SessionsListResult }
  'thread.messages': { params: ThreadMessagesParams; result: ThreadMessagesResult }
  'models.list': { params: Record<string, never>; result: ModelsListResult }
  status: { params: Record<string, never>; result: StatusResult }
  // Later phases; answered with `not_implemented` for now.
  'chat.send': { params: unknown; result: unknown }
  'cowork.send': { params: unknown; result: unknown }
  'run.stop': { params: unknown; result: unknown }
  'approvals.list': { params: unknown; result: unknown }
  /** `scope: 'always'` needs "Allow 'Always allow' from phones" (checked by the server too). */
  'approvals.respond': { params: unknown; result: unknown }
}

export type RemoteMethod = keyof RemoteMethods

/** `remote://rpc` payload: a phone's call, as the server hands it over. */
export type RemoteRpcRequest = {
  id: string
  method: string
  params: unknown
  device: { id: string; name: string }
}

// ---------------------------------------------------------------------------
// Events (desktop -> phone)
// ---------------------------------------------------------------------------

export type RemoteEvent =
  | { type: 'approval.requested'; requestId: string; toolName: string; threadId: string }
  | { type: 'approval.resolved'; requestId: string }
  | { type: 'run.started'; kind: SessionKind; id: string }
  | { type: 'run.finished'; kind: SessionKind; id: string }
  | { type: 'notification'; title: string; body: string }

/** One WebSocket message from the server. */
export type RemoteSocketMessage =
  | { type: 'ready'; deviceId: string }
  | { type: 'event'; topic: string | null; event: RemoteEvent }
  | { type: 'lagged'; missed: number }
  | { type: 'pong' }

/** One WebSocket message to the server. */
export type RemoteClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; topics: string[] }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'ping' }

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export type PairRequest = { code: string; deviceName: string }
export type PairResponse = { status: 'pending'; pollId: string; confirmNumber: string }
export type PairStatus =
  | { status: 'pending' }
  | { status: 'approved'; token: string; deviceId: string }
  | { status: 'rejected' }
  | { status: 'expired' }
