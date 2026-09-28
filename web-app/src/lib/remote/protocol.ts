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
  | 'desktop_only'

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
  /** Pinned (starred) in the desktop's sidebar. */
  pinned?: boolean
}

export type SessionsListParams = { kind?: SessionKind; limit?: number }
export type SessionsListResult = { sessions: SessionSummary[] }

/** A tool call's kind, for its colour (lib/toolKind.ts). */
export type RemoteToolKind =
  | 'read'
  | 'search'
  | 'web'
  | 'bash'
  | 'edit'
  | 'todo'
  | 'fail'
  | 'warn'
  | 'appr'
  | 'other'

/** One tool call, as the desktop's timeline row shows it. */
export type RemoteToolStep = {
  id: string
  /** The tool's own name (`read`, `web_search`, `github.list_checks`). */
  name: string
  kind: RemoteToolKind
  status: 'running' | 'done' | 'failed' | 'awaiting'
  /** The one argument that says what it acted on (a path, a command). */
  arg?: string
  /** Where it came from: Workspace, Web, `MCP · github`. */
  origin?: string
}

export type RemoteMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** Plain text of the message. */
  text: string
  /** Unix ms. */
  createdAt: number
  /** Room speaker, when the message is from a room. */
  author?: string
  /** Room speaker's role and model, when known. */
  authorRole?: string
  authorModel?: string
  /** Tool calls the message made, in order (Cowork). */
  tools?: RemoteToolStep[]
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
  /** The provider's shown name ("Llama.cpp", a user's rename). */
  providerName?: string
  local: boolean
  loaded: boolean
  /** Starred in the desktop's model picker. */
  favorite?: boolean
}
export type ModelsListResult = { models: RemoteModel[] }

export type StatusResult = {
  modelsLoaded: number
  runs: { kind: SessionKind; id: string }[]
  approvalsWaiting: number
  /** What the computer lets phones do (Settings › Remote access). Absent when
   * the window could not read its own settings. */
  permissions?: { approvals: boolean; alwaysAllow: boolean }
}

export type IdParams = { id: string }

export type RoomParticipant = {
  id: string
  name: string
  role: string
  model: string
  provider: string
  toolAccess: 'none' | 'read' | 'edit'
}

export type RoomDetail = {
  id: string
  title: string
  objective: string
  status: SessionStatus
  /** The desktop's own status word (`awaiting-user`, `completed`). */
  roomStatus: string
  mode: 'round-robin' | 'user-selected' | 'moderator-selected'
  participants: RoomParticipant[]
  moderator: { enabled: boolean; name: string; model: string | null }
  nextSpeakerId: string | null
  round: number
  folder: string | null
  limits: {
    maxRounds: number
    maxTurns: number
    maxTotalTokens: number
    maxOutputTokensPerTurn: number
    maxCostUsd: number | null
    maxDurationMs: number
  }
  usage: {
    turns: number
    rounds: number
    tokens: number
    costUsd: number | null
    activeMs: number
  }
}

export type CoworkTodo = { text: string; status: 'pending' | 'in_progress' | 'completed' }

export type CoworkDetail = {
  id: string
  title: string
  status: SessionStatus
  folder: string | null
  group?: string
  /** What the session may do. */
  mode: 'review' | 'ask' | 'auto'
  /** Where its changes go. */
  access: 'review-only' | 'managed-worktree' | 'edit-folder'
  model: { id: string; provider: string } | null
  todos: CoworkTodo[]
  usage: { inputTokens: number; outputTokens: number } | null
}

/** A waiting permission prompt, worded as the desktop's approval card. */
export type RemoteApproval = {
  requestId: string
  threadId: string
  toolName: string
  serverName?: string
  /** "Flint wants to run a command in acme-weather". */
  title: string
  /** The command, path or address it acts on. */
  subject?: string
  why?: string
  consequences: string[]
  /** In the server's words (`always` is gated by "Allow 'Always allow' from phones"). */
  scopes: { scope: 'once' | 'thread' | 'always'; label: string; explanation: string; broader: boolean }[]
  argumentsJson: string
  requestedAt?: number
}
export type ApprovalsListResult = { approvals: RemoteApproval[] }

export type SystemInfo = {
  computerName: string | null
  os: string
  cpu: { name: string; cores: number; arch: string; extensions: string[]; usage: number }
  /** Megabytes, as the desktop's hardware store holds them. */
  ram: { total: number; used: number }
  gpus: { name: string; vram: number; used: number | null; driver?: string }[]
  localApi: { running: boolean; host: string; port: number; prefix: string }
}

export type McpServerInfo = {
  name: string
  active: boolean
  transport: 'stdio' | 'http' | 'sse'
  description?: string
}
export type ToolsListResult = { servers: McpServerInfo[] }

/** Settings the phone shows, read from the desktop's stores. */
export type SettingsSnapshot = {
  version: string
  theme: 'auto' | 'light' | 'dark'
  spellCheck: boolean | null
  language: string | null
  localApi: { enabled: boolean; host: string; port: number; prefix: string; cors: boolean; hasKey: boolean }
  webSearch: { enabled: boolean; provider: string | null }
  proxy: { enabled: boolean; url: string; verifySsl: boolean; noProxy: string }
  /** Jev's two opt-ins, in the desktop's words (`off`, `auto`, ...). */
  jev: { skills: string; rerank: string } | null
  agentTools: boolean | null
  mcpServers: { total: number; active: number }
  providers: { total: number; active: number }
  remote: { allowApprovals: boolean; allowAlwaysAllow: boolean; interface: string } | null
  /** This phone's notification choices, when it has set them. */
  notifications?: NotificationPrefs
}

/** The desktop's accent, as inline CSS variables per theme (lib/accent.ts);
 * empty for the default. */
export type AppearanceResult = {
  vars: { light: Record<string, string>; dark: Record<string, string> }
}

// ---------------------------------------------------------------------------
// Acting on the computer (phase 3)
// ---------------------------------------------------------------------------

export type ModelRef = { id: string; provider: string }
export type ReasoningMode = 'auto' | 'on' | 'off'
export type CoworkModeId = CoworkDetail['mode']
export type CoworkAccessId = CoworkDetail['access']

/** Every send carries a `clientId` the phone makes once per message: a retry
 * after a dropped connection sends the same one, and the computer answers it
 * with the first result instead of sending twice. */
export type ChatSendParams = {
  clientId: string
  text: string
  /** An existing chat; omitted (or `new: true`) starts one. */
  id?: string
  new?: boolean
  /** New chats only: the model to start with. */
  model?: ModelRef
  /** The composer's toggles, applied as the desktop composer applies them. */
  webSearch?: boolean
  reasoning?: ReasoningMode
  /** While a run is going: hand it to the run at its next safe point
   * (the desktop's Ctrl+Enter) instead of queueing it. */
  steer?: boolean
}

export type CoworkSendParams = {
  clientId: string
  text: string
  id?: string
  new?: boolean
  /** New sessions: a folder the desktop already knows (recent folders). */
  folder?: string
  mode?: CoworkModeId
  /** Only `review-only` can be chosen from a phone; the others need the
   * desktop's own consent dialog. */
  access?: CoworkAccessId
  model?: ModelRef
  steer?: boolean
}

export type RoomSendParams = {
  clientId: string
  id: string
  text: string
  /** A participant id, `moderator`, or null/omitted for everyone. */
  to?: string | null
}

export type SendResult = {
  kind: SessionKind
  /** The conversation it went to (new for a new chat or session). */
  id: string
  /** `sent`: a run started with it. `queued`: a run was going, so it waits
   * its turn, as on the desktop. `steered`: handed to the running turn. */
  delivery: 'sent' | 'queued' | 'steered'
  /** The same `clientId` was seen before; this is the first answer again. */
  duplicate?: boolean
}

export type RunStopParams = { kind: SessionKind; id: string; all?: false } | { all: true }
export type RunStopResult = { stopped: number }

export type RoomControlParams = {
  id: string
  action: 'start' | 'pause' | 'resume' | 'stop' | 'cancel' | 'next' | 'vote' | 'synthesize' | 'final'
  /** `next`: who speaks next. */
  participantId?: string
  /** `vote`: what to vote on. */
  proposal?: string
}

export type ApprovalRespondParams = {
  requestId: string
  decision: 'allow' | 'deny'
  scope?: 'once' | 'thread' | 'always'
}
/** `gone`: nothing waits under that id any more -- it was answered on the
 * computer (or another phone), or its run ended. */
export type ApprovalRespondResult = { status: 'answered' | 'gone' }

export type NotificationPrefs = {
  approvals: boolean
  runFinished: boolean
  roomTurns: boolean
  errors: boolean
}

export type SettingsSetParams =
  | { key: 'webSearch'; value: boolean }
  | { key: 'notifications'; value: NotificationPrefs }
  | { scope: 'chat'; id: string; reasoning?: ReasoningMode; model?: ModelRef }
  | {
      scope: 'cowork'
      id: string
      mode?: CoworkModeId
      access?: CoworkAccessId
      model?: ModelRef
    }

/** The reply being written in a conversation right now, for a phone that
 * (re)opens it mid-run. */
export type StreamGetParams = { kind: SessionKind; id: string }
export type StreamSnapshot = {
  kind: SessionKind
  id: string
  messageId: string
  text: string
  reasoning: string
  tools: RemoteToolStep[]
  /** Room: who is speaking. */
  author?: string
}

export type QueuedItem = {
  id: string
  text: string
  /** Goes to the running turn at its next safe point. */
  steer: boolean
  /** Waits for the user to send or discard it (after a stop or a restart). */
  held: boolean
  /** Mail from another session: its name. */
  from?: string
}
export type QueueResult = { items: QueuedItem[] }

export type ChangedFile = {
  path: string
  additions: number
  deletions: number
  /** Who wrote it: the run, a subagent (its name), or the user. */
  source: string
  /** Unified-diff text of each write, oldest first (capped). */
  hunks: string[]
}

export type RemotePr = {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: { passed: number; failed: number; pending: number }
  conflicts: boolean
}

export type CoworkChanges = {
  files: ChangedFile[]
  /** "3 files changed · +24 −8", once a run has finished; null otherwise. */
  summary: string | null
  /** Where the work happens: a managed worktree's branch and path. */
  worktree: { branch: string | null; path: string } | null
  pr: RemotePr | null
  /** Applying a copy's changes to the folder is done on the computer. */
  applyOnDesktop: boolean
}

export type CoworkActivity = {
  subagents: { id: string; name: string; status: 'queued' | 'running' | 'done'; startedAt: number; endedAt?: number; steps: number }[]
  commands: { id: string; command: string; status: RemoteToolStep['status'] }[]
}

export type LibraryItem = {
  path: string
  title: string
  group: string
  label: string
  sessionId: string
  sessionTitle: string
  updatedAt: number
}
export type LibraryResult = { items: LibraryItem[] }

/** Every method a phone may call, with its params and result. */
export type RemoteMethods = {
  'sessions.list': { params: SessionsListParams; result: SessionsListResult }
  'thread.messages': { params: ThreadMessagesParams; result: ThreadMessagesResult }
  'models.list': { params: Record<string, never>; result: ModelsListResult }
  status: { params: Record<string, never>; result: StatusResult }
  'rooms.get': { params: IdParams; result: RoomDetail }
  'cowork.get': { params: IdParams; result: CoworkDetail }
  'approvals.list': { params: Record<string, never>; result: ApprovalsListResult }
  'system.info': { params: Record<string, never>; result: SystemInfo }
  'tools.list': { params: Record<string, never>; result: ToolsListResult }
  'settings.get': { params: Record<string, never>; result: SettingsSnapshot }
  'appearance.get': { params: Record<string, never>; result: AppearanceResult }
  'stream.get': { params: StreamGetParams; result: StreamSnapshot | null }
  'thread.queue': { params: IdParams; result: QueueResult }
  'cowork.changes': { params: IdParams; result: CoworkChanges }
  'cowork.activity': { params: IdParams; result: CoworkActivity }
  'library.list': { params: Record<string, never>; result: LibraryResult }
  'chat.send': { params: ChatSendParams; result: SendResult }
  'cowork.send': { params: CoworkSendParams; result: SendResult }
  'run.stop': { params: RunStopParams; result: RunStopResult }
  'room.send': { params: RoomSendParams; result: SendResult }
  'room.control': { params: RoomControlParams; result: { ok: true } }
  'settings.set': { params: SettingsSetParams; result: { ok: true } }
  /** `scope: 'always'` needs "Allow 'Always allow' from phones" (checked by the server too). */
  'approvals.respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
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
  /** Reply text (and reasoning) appended at `offset` of what was sent so far
   * for `messageId`. A phone that sees a gap asks `stream.get`. */
  | {
      type: 'stream.delta'
      kind: SessionKind
      id: string
      messageId: string
      offset: number
      text: string
      reasoningOffset?: number
      reasoning?: string
      author?: string
    }
  /** A tool step began or changed. */
  | { type: 'stream.tool'; kind: SessionKind; id: string; messageId: string; step: RemoteToolStep }
  /** The reply is complete (or stopped); read `thread.messages` for it. */
  | { type: 'stream.done'; kind: SessionKind; id: string; messageId: string }
  /** Messages, queue or details of a conversation changed. */
  | { type: 'thread.updated'; kind: SessionKind; id: string }

/** Conversation-scoped events go to sockets subscribed to this topic. */
export const threadTopic = (id: string) => `thread:${id}`

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
