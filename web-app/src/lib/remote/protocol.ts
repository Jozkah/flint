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
  /** A reply's footer facts, as the desktop's reply row shows them. */
  meta?: ReplyMeta
  /**
   * Present only when the message has other versions (an edited question, a
   * regenerated reply): which one this is, 1-based, of how many. Older phones
   * ignore it and show the version in force, which is all `thread.messages`
   * sends them.
   */
  versions?: { index: number; count: number }
}

/** What a reply's header and footer say (#47, #61, #84). */
export type ReplyMeta = {
  /** The assistant that answered (Quartz, Coal, ...), when not Flint. */
  assistant?: string
  /** The model that answered. */
  model?: string
  /** Generation speed, tokens per second. */
  tokensPerSecond?: number
  /** Prompt reading speed, tokens per second. */
  promptPerSecond?: number
  outputTokens?: number
  /** The prompt cache: reused (some input read from it), none, or not reported. */
  cache?: 'reused' | 'none'
  /** Speculative decoding: how many drafted tokens were kept. */
  draft?: { accepted: number; tokens: number }
  /** Skills the reply read (`plugin:skill` or `skill`). */
  skills?: string[]
}

/** Step a message to the previous (-1) or next (+1) version of itself. */
export type ThreadBranchSelectParams = {
  id: string
  messageId: string
  dir: -1 | 1
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
  toolAccess: 'none' | 'read' | 'edit' | 'full'
  /** Persisted participant reasoning override when one exists. */
  reasoning?: { mode?: ReasoningMode; level?: string }
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
  moderator: { enabled: boolean; name: string; model: string | null; provider?: string }
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
  /** The last request against the session's context window (the ring). */
  context?: { usedTokens: number; windowTokens: number | null }
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
  scopes: { scope: 'once' | 'thread' | 'always' | 'temporary'; label: string; explanation: string; broader: boolean }[]
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
  /** Settings › Jev › Automatic choices (#47); changed on the computer. */
  automation?: { routeAssistants: boolean; activateSkills: boolean }
  /** Search providers the computer offers, and whether each needs a key (#58). */
  webSearchProviders?: { id: string; name: string; needsKey: boolean; configured: boolean }[]
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

export type RoomCreateParticipant = {
  name: string
  role: string
  model: ModelRef
  toolAccess: 'none' | 'read' | 'edit' | 'full'
  reasoning?: { mode?: ReasoningMode; level?: string }
}
export type RoomCreateParams = {
  title: string
  objective?: string
  mode?: RoomDetail['mode']
  participants: RoomCreateParticipant[]
  moderator?: { enabled: boolean; name?: string; model?: ModelRef }
}
export type RoomUpdateParams = {
  id: string
  patch: {
    title?: string
    objective?: string
    mode?: RoomDetail['mode']
    participants?: Array<{ id: string; model?: ModelRef; reasoning?: { mode?: ReasoningMode; level?: string } }>
    moderator?: { enabled?: boolean; name?: string; model?: ModelRef }
    limits?: Partial<RoomDetail['limits']>
  }
}
export type RoomMutationResult = { ok: true; id: string }

/** Every send carries a `clientId` the phone makes once per message: a retry
 * after a dropped connection sends the same one, and the computer answers it
 * with the first result instead of sending twice. */
/** A file the desktop would not attach, with the composer's reason. */
export type AttachmentRejection = { name: string; reason: string; message: string }

export type ChatSendParams = {
  clientId: string
  text: string
  /** Finished uploads (`/remote/v1/upload`) to attach, by id. */
  attachments?: string[]
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
  attachments?: string[]
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
  /** Attachments the desktop refused; the rest went with the message. */
  rejected?: AttachmentRejection[]
}

/** `scope: 'chat'` is the desktop's "Stop all in this chat" (#33): every run,
 * tool, command and agent under the conversation. */
export type RunStopParams =
  | { kind: SessionKind; id: string; all?: false; scope?: 'task' | 'chat' }
  | { all: true }
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
  /** `temporary`: the desktop's "Allow all temporarily" for routine Git
   * remote operations in this conversation (#45), offered only when the
   * approval lists it. */
  scope?: 'once' | 'thread' | 'always' | 'temporary'
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
  /** Set for a Studio result: its media loads with `studio.media`. */
  studio?: StudioItemWire
}
export type LibraryResult = { items: LibraryItem[] }


// ---------------------------------------------------------------------------
// Desktop updates #30–#87: chat details, effort, assistants, code/preview,
// Hugging Face
// ---------------------------------------------------------------------------

export type EffortLevelWire = 'low' | 'medium' | 'high' | 'xhigh'
export type EffortChoiceWire = EffortLevelWire | 'off'

/** One kind of thing in the context window (lib/contextBreakdown.ts). */
export type ContextSegmentWire = { id: string; label: string; tokens: number; color: string }

export type ContextWindowWire = {
  usedTokens: number
  windowTokens: number | null
  autoCompactOn: boolean
  /** Held back for compaction to run in. */
  buffer: number
  segments: ContextSegmentWire[]
}

/** One card of "What Flint is using" (containers/WhatJanIsUsing.tsx). */
export type UsingSection = {
  id: 'model' | 'instructions' | 'attachments' | 'memory' | 'tools' | 'payload'
  title: string
  items: { label: string; detail?: string; state: string }[]
  empty?: string
}

export type ChatDetails = {
  id: string
  model: { id: string; provider: string; name: string } | null
  /** The chat's model was removed from the computer. */
  modelMissing: boolean
  /** `auto`: still on Flint, so Jev may route each turn. */
  assistant: { id: string; name: string; auto: boolean }
  effort: {
    levels: EffortLevelWire[]
    recommended: EffortLevelWire | null
    canDisable: boolean
    value: EffortChoiceWire | null
    overridden: boolean
  } | null
  context: ContextWindowWire | null
  speed: { last: number | null; average: number | null }
  lastRequest: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | null
  sections: UsingSection[]
  /** MCP servers the conversation mentioned that are not running. */
  serversOff: string[]
  files: { name: string; state: string }[]
  /** "Compact session" works while the chat is open on the computer. */
  canCompact: boolean
}

export type ChatEffortParams = { id: string; choice: EffortChoiceWire | null }
export type ChatAssistantParams = { id: string; assistant: string }
export type ChatForkParams = { id: string; messageId?: string }
export type TitleRegenerateParams = { kind: SessionKind; id: string }
export type TitleRegenerateResult = { result: 'done' | 'empty' | 'busy' | 'failed' }

export type AssistantInfo = { id: string; name: string; description?: string; builtIn: boolean }
export type AssistantsResult = { assistants: AssistantInfo[]; routing: boolean }

export type RoomClearParams = { id: string; scope: 'chat' | 'knowledge' | 'everything' }

export type ProjectEntryWire = { name: string; relPath: string; isDir: boolean }
export type CoworkFilesParams = { id: string; path?: string }
export type CoworkFilesResult = { root: string | null; entries: ProjectEntryWire[]; truncated: boolean }
export type CoworkFileParams = { id: string; path: string }
export type CoworkFileResult = {
  path: string
  status: 'ready' | 'oversized' | 'binary' | 'sensitive' | 'denied' | 'missing'
  content: string
  /** Line numbers (1-based) the session added or changed. */
  changed: Record<number, 'add' | 'mod'>
  language: string
  /** Files the session wrote, for the open-file tabs. */
  touched: string[]
}
export type CoworkPreviewResult = {
  /** Previewable files the session made, newest last. */
  artifacts: string[]
  path: string | null
  kind: 'html' | 'svg' | 'markdown' | 'text' | 'image' | 'other' | null
  /** The file's text (HTML, SVG, Markdown), capped. */
  content: string | null
  note?: string
  /** The desktop shows this session's app live (a local URL); a phone can
   * view it through the server with a `preview.ticket`. */
  live?: { url: string }
}

export type HfVariant = { quant: string; sizeBytes: number | null; fits: boolean | null }
export type HfModelCard = {
  repo: string
  author: string | null
  downloads: number
  likes: number
  tags: string[]
  pipelineTag: string | null
  installed: boolean
  variants: HfVariant[]
}
export type HfSearchParams = { query?: string; modality?: 'all' | 'text' | 'vision' | 'audio' | 'code' | 'embeddings' }
export type HfSearchResult = { models: HfModelCard[]; device: { name: string; vramBytes: number } | null }
export type HfDownloadParams = { repo: string; quant?: string }
export type DownloadTaskWire = {
  id: string
  label: string
  status: string
  progress: number
  downloaded: number
  total: number | null
  bytesPerSecond: number | null
}

/** Every method a phone may call, with its params and result. */

// ---------------------------------------------------------------------------
// Studio and dictation (the desktop runs both; phones drive them)
// ---------------------------------------------------------------------------

export type StudioKindWire = 'image' | 'video'
export type StudioModelWire = {
  id: string
  name: string
  kind: StudioKindWire
  installed: boolean
  totalBytes: number
  /** Frames a second, for a video model. */
  fps: number | null
}
export type StudioJobWire = {
  kind: StudioKindWire
  prompt: string
  phase: string
  fraction: number
  startedAt: number
  /** How many images this job makes (1 for a video). */
  count: number
}
export type StudioActivityWire = {
  id: number
  kind: StudioKindWire
  prompt: string
  status: 'making' | 'done' | 'failed' | 'stopped'
  error?: string
  durationMs: number
  at: number
}
export type StudioStatusResult = {
  supported: boolean
  engineTag: string
  engineBackend: string | null
  models: StudioModelWire[]
  resident: { modelId: string; kind: StudioKindWire; busy: boolean } | null
  job: StudioJobWire | null
  download: { modelId: string; bytes: number; total: number } | null
  activity: StudioActivityWire[]
  /** Set when video would swap on this computer; must be acknowledged. */
  memoryWarning: string | null
  memoryGb: number | null
  error: string | null
  sizes: Record<StudioKindWire, { label: string; short: string }[]>
  videoSeconds: number[]
}
export type StudioRecipeWire = {
  prompt: string
  negativePrompt: string
  width: number
  height: number
  seed: number
  modelName: string
  frames: number | null
  fps: number | null
  createdAtMs: number
  durationMs: number
}
export type StudioItemWire = { id: string; kind: StudioKindWire; recipe: StudioRecipeWire }
export type StudioGenerateParams = {
  kind: StudioKindWire
  prompt: string
  negative?: string
  sizeIndex?: number
  count?: number
  seconds?: number
  seed?: number
  /** The phone showed the low-memory warning and the user accepted it. */
  memoryAcknowledged?: boolean
}
export type StudioItemParams = { kind: StudioKindWire; id: string }
export type VoiceStatusResult = { ready: boolean }
/** `audio` is base64 16 kHz mono 16-bit WAV. */
export type VoiceTranscribeParams = { audio: string; language?: string }

// ---------------------------------------------------------------------------
// Push (answered by the server itself, not the window)
// ---------------------------------------------------------------------------

export type PushCategory =
  | 'approval'
  | 'runFinished'
  | 'runFailed'
  | 'pr'
  | 'roomWaiting'
  | 'synthesis'
  | 'chatReply'
  | 'test'

export type PushNotice = {
  category: PushCategory
  title: string
  body: string
  /** In-app path, `/m/#/...`. */
  url: string
  /** Collapses notifications about the same thing. */
  tag: string
  requestId?: string
}

export type PushPrefs = {
  approvals: boolean
  runFinished: boolean
  runFailed: boolean
  pr: boolean
  roomWaiting: boolean
  synthesis: boolean
  chatReply: boolean
  hideContent: boolean
  /** Minutes after local midnight; approvals still come through. */
  quietHours: { enabled: boolean; start: number; end: number }
  utcOffsetMinutes: number
}

export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } }

/** What the service worker receives. */
export type PushPayload = {
  title: string
  body: string
  url: string
  tag: string
  category: PushCategory
  requestId?: string
}

export type ArchiveKindWire = 'thread' | 'room' | 'cowork' | 'project'

export type ArchiveItemWire = {
  /** `<kind>:<name in the archive>`; what restore and purge take back. */
  key: string
  kind: ArchiveKindWire
  title: string
  /** Milliseconds since the epoch. */
  archivedAt: number
  sizeBytes: number
}

export type ArchiveListResult = {
  items: ArchiveItemWire[]
  /** Days an archived item is kept before it is deleted; 0 keeps it for good. */
  retentionDays: number
}

export type ArchiveKeyParams = { key: string }

export type ArchiveEmptyResult = {
  purged: number
  /** Items a guard kept (a Cowork session whose worktree holds unmerged work). */
  blocked: { title: string; reason: string }[]
}

export type RemoteMethods = {
  'push.vapidKey': { params: Record<string, never>; result: { key: string } }
  'push.get': { params: Record<string, never>; result: { subscribed: boolean; available: boolean; prefs: PushPrefs } }
  'push.subscribe': { params: { subscription: PushSubscriptionJson; prefs?: PushPrefs }; result: { ok: true } }
  'push.unsubscribe': { params: Record<string, never>; result: { ok: true } }
  'push.prefs': { params: { prefs: PushPrefs }; result: { prefs: PushPrefs } }
  'push.test': { params: Record<string, never>; result: { sent: number } }
  /** Answered by the server: a path to load the session's live preview. */
  'preview.ticket': { params: { id: string }; result: { path: string } }
  'sessions.list': { params: SessionsListParams; result: SessionsListResult }
  'thread.messages': { params: ThreadMessagesParams; result: ThreadMessagesResult }
  /** `ok: false` when there is no version that way or the chat is mid-reply. */
  'thread.branch.select': { params: ThreadBranchSelectParams; result: { ok: boolean } }
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
  'room.create': { params: RoomCreateParams; result: RoomMutationResult }
  'room.update': { params: RoomUpdateParams; result: RoomMutationResult }
  'room.delete': { params: IdParams; result: { ok: true } }
  'settings.set': { params: SettingsSetParams; result: { ok: true } }
  /** `scope: 'always'` needs "Allow 'Always allow' from phones" (checked by the server too). */
  'approvals.respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
  'chat.details': { params: IdParams; result: ChatDetails }
  'chat.effort': { params: ChatEffortParams; result: { ok: true } }
  'chat.assistant': { params: ChatAssistantParams; result: { ok: true } }
  'chat.fork': { params: ChatForkParams; result: { id: string } }
  'chat.compact': { params: IdParams; result: { started: boolean } }
  'title.regenerate': { params: TitleRegenerateParams; result: TitleRegenerateResult }
  'assistants.list': { params: Record<string, never>; result: AssistantsResult }
  'room.clear': { params: RoomClearParams; result: { ok: true } }
  'cowork.files': { params: CoworkFilesParams; result: CoworkFilesResult }
  'cowork.file': { params: CoworkFileParams; result: CoworkFileResult }
  'cowork.preview': { params: { id: string; path?: string }; result: CoworkPreviewResult }
  'hf.search': { params: HfSearchParams; result: HfSearchResult }
  'hf.download': { params: HfDownloadParams; result: { ok: true; id: string } }
  'models.downloads': { params: Record<string, never>; result: { tasks: DownloadTaskWire[] } }
  'studio.status': { params: Record<string, never>; result: StudioStatusResult }
  'studio.load': { params: { modelId: string }; result: { ok: true } }
  'studio.unload': { params: Record<string, never>; result: { ok: true } }
  'studio.download': { params: { modelId: string }; result: { ok: true } }
  'studio.generate': { params: StudioGenerateParams; result: { started: true } }
  'studio.stop': { params: Record<string, never>; result: { ok: true } }
  'studio.gallery': { params: { kind: StudioKindWire }; result: { items: StudioItemWire[] } }
  'studio.media': { params: StudioItemParams; result: { dataUrl: string } }
  'studio.remix': { params: StudioItemParams; result: { started: true } }
  'studio.delete': { params: StudioItemParams; result: { ok: true } }
  /** The archive of deleted items; a phone can list, restore and delete them for good. */
  'archive.list': { params: Record<string, never>; result: ArchiveListResult }
  'archive.restore': { params: ArchiveKeyParams; result: { ok: true } }
  'archive.purge': { params: ArchiveKeyParams; result: { ok: true } }
  'archive.empty': { params: { kind?: ArchiveKindWire }; result: ArchiveEmptyResult }
  'voice.status': { params: Record<string, never>; result: VoiceStatusResult }
  'voice.transcribe': { params: VoiceTranscribeParams; result: { text: string } }
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
  /** Not sent to sockets: the server turns it into Web Push for phones that
   * are not looking (src-tauri/src/core/remote/push.rs). */
  | ({ type: 'push.notify' } & PushNotice)
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
  /** Studio's job moved on (progress), throttled to a few a second. */
  | { type: 'studio.progress'; job: StudioJobWire | null }
  /** Studio's models, gallery or activity changed; read `studio.status`. */
  | { type: 'studio.updated' }

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
  /** The page was hidden or shown; a hidden page gets Web Push instead. */
  | { type: 'visibility'; hidden: boolean }

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
