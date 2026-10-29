// The remote-access wire protocol: constants, shared data shapes and method parameters. Re-exported by protocol.ts.
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
  /** Carry on a run that stopped (the desktop's "Keep going"); an
   * interrupted turn's finished steps are kept first. */
  resume?: boolean
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

export type RemoteAskQuestion = {
  id: string
  question: string
  options: { label: string; description?: string }[]
  /** Several options may be chosen. */
  multi?: boolean
  /** Index of the option the model recommends. */
  recommended?: number
}
/** A question a Cowork run is waiting on (its `ask` tool): one or more
 * multiple-choice questions, answered together. Plan review and the opening
 * "continue?" proposal are questions too. */
export type RemoteAsk = {
  requestId: string
  /** The Cowork session that asked. */
  threadId: string
  questions: RemoteAskQuestion[]
  /** The staged plan, under a plan-review question. */
  plan?: { name: string; tasks: { content: string; done: boolean }[] }[]
  requestedAt?: number
}
export type AsksListResult = { asks: RemoteAsk[] }
/** One answer per question: option labels, or the user's own words. */
export type RemoteAskAnswer = { id: string; selected: string[]; custom_input?: string }
export type AskRespondParams = {
  requestId: string
  threadId: string
  /** `null` skips the question: the run is told nothing was chosen. */
  answers: RemoteAskAnswer[] | null
}
export type AskRespondResult = { status: 'answered' | 'gone' }

/** One of the desktop's other blocking prompts (a folder outside the
 * workspace, a site for the assistant's browser, overlapping team tasks, a
 * local model out of context), with the answers a phone may give. */
export type RemotePrompt = {
  id: string
  kind: 'access' | 'domain' | 'conflict' | 'context'
  /** The conversation that waits on it, when it belongs to one. */
  threadId?: string
  title: string
  body?: string
  /** The path, address or files it is about. */
  detail?: string
  /** Who is asking, when it is a subagent or a team child. */
  origin?: string
  actions: { id: string; label: string; style?: 'primary' | 'danger' }[]
}
export type PromptsListResult = { prompts: RemotePrompt[] }
export type PromptRespondParams = { id: string; action: string }
export type PromptRespondResult = { status: 'answered' | 'gone' }

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
/** Regenerate a reply (the last one when `messageId` is absent). */
export type ChatRegenerateParams = { id: string; messageId?: string }
/** Edit a message: the old version is kept beside the new one, and a
 * question gets a new reply. */
export type ChatEditParams = { id: string; messageId: string; text: string }
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

// ---------------------------------------------------------------------------
// Campaigns (the desktop's Campaigns board, read and steered from a phone)
// ---------------------------------------------------------------------------

/** What the board offers on a campaign or one of its tasks. Mutations travel
 * under an `approvals.` name so the server's approvals switch covers them. */
export type CampaignActionWire =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'finalize'
  | 'apply'
  | 'retry'
  | 'skip'
  | 'stop'

export type CampaignTaskWire = {
  id: string
  title: string
  /** `CampaignTaskStatus` of the desktop's model. */
  status: string
  dependsOn: string[]
  attempt: number
  sessionId: string | null
  /** The latest note on the task (the failure text, the retry hint). */
  detail: string
  verdict: string | null
  /** Counts only, from the task's worktree; null when not asked or unknown. */
  files: { count: number; added: number; removed: number; uncommitted: boolean } | null
}

export type CampaignWire = {
  id: string
  title: string
  /** `CampaignStatus` of the desktop's model. */
  status: string
  coordinatorSession: string
  updatedAt: string
  tasks: CampaignTaskWire[]
  maxParallel: number
  tokenBudget: number | null
  tokensUsed: number
  proposalId: string | null
  gate: { passed: boolean; skipped: boolean; command: string } | null
}

export type CampaignProposalFileWire = {
  path: string
  change: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary: boolean
  /** Never applied, whatever is chosen. */
  sensitive: boolean
  /** One line per review flag; the file needs a tick before it is applied. */
  flags: string[]
}

export type CampaignDetailResult = {
  campaign: CampaignWire
  proposal: { id: string; state: string; files: CampaignProposalFileWire[] } | null
  /** The command the gate will run, while the campaign waits for review. */
  gateCommand: string | null
}

export type CampaignActParams = {
  id: string
  action: CampaignActionWire
  taskId?: string
  /** `apply`: flagged files the person marked as looked at. */
  acknowledged?: string[]
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

export type ArchiveKindWire = 'thread' | 'room' | 'cowork' | 'project' | 'assistant' | 'studio'

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
