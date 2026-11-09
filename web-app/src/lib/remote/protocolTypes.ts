// The remote-access wire protocol: constants, shared data shapes and the
// reading methods' parameters. Re-exported by protocol.ts.
// Kept free of app imports so the phone bundle can use it as is.

import type { ReasoningMode, NotificationPrefs } from './protocolActing'

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

export type SessionsListParams = {
  kind?: SessionKind
  limit?: number
  /** Only sessions updated strictly before this time (Unix ms): the
   * `updatedAt` of the last session of the previous page. */
  before?: number
}
/** `total` counts every session of the asked kind, before paging. Older
 * desktops leave it out. */
export type SessionsListResult = { sessions: SessionSummary[]; total?: number }

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
  /** What it was called with and what came back, cut to a phone-sized
   * length. Stored messages only; a live step carries neither. */
  input?: string
  output?: string
}

/** A file sent with a message: its name and kind, never its bytes. */
export type RemoteAttachment = { name: string; kind: 'image' | 'audio' | 'video' | 'file' }

/** A line the desktop draws in the transcript that is not a message. */
export type RemoteNote = { kind: 'compaction' | 'stopped' | 'answered' | 'error'; text: string }

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
  /** Tool calls the message made, in order. */
  tools?: RemoteToolStep[]
  /** The model's reasoning before the reply, cut to a phone-sized length. */
  reasoning?: string
  attachments?: RemoteAttachment[]
  notes?: RemoteNote[]
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
  /** Questions a Cowork run is waiting on. Absent from an older computer. */
  questionsWaiting?: number
  /** Other prompts waiting (`prompts.list`). Absent from an older computer. */
  promptsWaiting?: number
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
  mode: 'round-robin' | 'user-selected' | 'moderator-selected' | 'compare'
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

/** `rooms.summaries`: the details of several rooms in one read, so a list can
 * show every card without one `rooms.get` each. Ids that are not rooms are
 * left out. Older desktops refuse the method; callers fall back to
 * `rooms.get`. */
export type RoomsSummariesParams = { ids: string[] }
export type RoomsSummariesResult = { rooms: RoomDetail[] }

export type CoworkTodo = { text: string; status: 'pending' | 'in_progress' | 'completed' }

export type CoworkDetail = {
  id: string
  title: string
  status: SessionStatus
  folder: string | null
  group?: string
  /** What the session may do. */
  mode: 'review' | 'ask' | 'auto' | 'bypass'
  /** Where its changes go. */
  access: 'review-only' | 'managed-worktree' | 'edit-folder'
  model: { id: string; provider: string } | null
  todos: CoworkTodo[]
  usage: { inputTokens: number; outputTokens: number } | null
  /** The last request against the session's context window (the ring). */
  context?: { usedTokens: number; windowTokens: number | null }
  /** How the last run ended, when it did not simply finish: the desktop shows
   * a notice with "Keep going" or "Try again" there. `interrupted`: the app
   * closed mid-turn. */
  ending?: { by: CoworkEndingKind; message?: string }
}
export type CoworkEndingKind = 'steps' | 'tokens' | 'error' | 'deadline' | 'timeout' | 'loop' | 'interrupted'

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
  /** Who is asking, when it is not the conversation's own agent (a subagent
   * or a team child). */
  origin?: string
  /** The diff a file-changing call would make, cut to a phone-sized length. */
  preview?: string
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
