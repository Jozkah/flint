/**
 * Shared Cowork session types, kept free of any store so the presentation layer
 * can be built and tested without pulling in zustand or the run driver.
 *
 * The shapes mirroring Rust structs keep snake_case field names verbatim: the
 * same JSON crosses the tool boundary in both directions, and renaming here
 * would mean a translation layer on every hop.
 */

/** A single visible transcript entry. `tool` rows are display-only and carry the
 * structured call/result so the UI can render a tool card. */
export type CoworkTurn = {
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** User-row only: data URLs of images attached via paste/file picker. */
  images?: string[]
  /**
   * User-row only: typed while the agent was working and handed to it at the
   * next safe point of that run, rather than starting a run of its own.
   * janhq/jan#8864.
   */
  steered?: boolean
  /**
   * User-row only: this row is mail from another agent session, handed to the
   * model wrapped as coordination data (docs/SESSION_MESSAGING.md). Rendered
   * as "Message from <name>", never as something the user typed.
   */
  from?: AgentMessageAttribution
  callId?: string
  name?: string
  args?: unknown
  /** Raw JSON argument text accumulated while the call streams, so the tool card
   * shows a live preview. Superseded once the parsed `args` land. */
  argsLive?: string
  result?: string
  isError?: boolean
  diff?: string
  status?: 'running' | 'done'
  /**
   * What became of this tool invocation.
   *
   * One durable item moves through these states; the invocation is never
   * replaced by its result and never removed when the stream ends. `status`
   * above is the older two-value form kept for turns already on disk, and is
   * derived from this when both are present.
   */
  toolState?:
    | 'requested'
    | 'awaiting-permission'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'refused'
    | 'stale'
    | 'timed-out'
  /** Epoch millis. Together with `endedAt` this is the duration shown. */
  startedAt?: number
  endedAt?: number
  /** Which run and agent made the call, when it was not the main one. */
  runId?: string
  agent?: string
  /** What the permission gate decided, when it was consulted. */
  permission?: 'allowed' | 'denied' | 'prompted-allowed' | 'prompted-denied'
  /** Exit status for a command, when the tool reports one. */
  exitCode?: number
  /**
   * The prompt snapshot this assistant turn was produced from. AH-078.
   *
   * Attached to the turn rather than kept as a single "latest": a run makes
   * many model calls, and a viewer showing the most recent one next to an
   * older turn would be showing the wrong payload.
   */
  promptSnapshot?: { id: string; hash: string; redactions: number }
  /**
   * Questions the run asked at this point in the conversation.
   *
   * Attached to the turn, not held in a single "current question" slot beside
   * the composer: a question is something that was asked at a moment, and it
   * belongs at that moment in the transcript. It stays there after it is
   * answered, so the answer is part of the history rather than something that
   * vanished when it was given.
   */
  asks?: AskRecord[]
}

/** Who sent a mailbox message, as carried on a transcript row. */
export type AgentMessageAttribution = {
  sessionId: string
  displayName: string
  messageId: string
  replyTo?: string | null
}

/**
 * One `ask` request, with what became of it.
 *
 * `pending` until answered; `answered` carries what was chosen; `cancelled` is
 * a skip or a stopped run; `stale` is a question whose run is gone -- the
 * process that was waiting for the answer no longer exists, so accepting one
 * would be a lie.
 */
export type AskRecord = {
  requestId: string
  request: AskRequestPayload
  /** Who asked: enough to tell two concurrent runs' questions apart. */
  sessionId: string
  runId?: string
  callId?: string
  agent?: string
  /** RFC3339, so the order survives a reload. */
  at: string
  state: 'pending' | 'answered' | 'cancelled' | 'stale'
  answers?: AskAnswer[]
}

/** Mirrors the Rust `Usage` struct (events.rs). */
export type Usage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/**
 * One subagent run, bucketed by its own run id so concurrent subagents never
 * share a transcript lane. Lives transiently in the run store while running,
 * then the finished set is committed onto its session.
 */
export type SubagentRun = {
  runId: string
  name: string
  status: 'queued' | 'running' | 'done'
  startedAt: number
  endedAt?: number
  /** 1-based FIFO queue position while `queued`; cleared on start. */
  waiting?: number
  /** The subagent's own trace. The final answer is in `finalOutput`, not here. */
  turns: CoworkTurn[]
  finalOutput?: string
  usage?: Usage
}

/** Mirrors the Rust `TodoItem`/`TodoPhase`/`TodoList` structs (todo.rs). */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

export type TodoItem = {
  content: string
  status: TodoStatus
}

export type TodoPhase = {
  name: string
  tasks: TodoItem[]
}

export type TodoList = {
  phases: TodoPhase[]
}

/** `/goal` state: set by `/goal <condition>`, checked after each turn completes,
 * cleared by `/goal clear` or once the evaluator reports it met. */
export type CoworkGoal = {
  condition: string
  turns: number
  status: 'active' | 'achieved'
  lastReason: string
}

/** Mirrors the Rust `OptionItem`/`Question`/`AskRequest` structs (interaction.rs). */
export type AskOption = {
  label: string
  description?: string
}

export type AskQuestion = {
  id: string
  question: string
  options: AskOption[]
  multi?: boolean
  recommended?: number
}

export type AskRequestPayload = {
  questions: AskQuestion[]
}

/** Mirrors `QuestionResult` (interaction.rs): one answer per question, either
 * selected option label(s) or free-text `custom_input` — never both. */
export type AskAnswer = {
  id: string
  selected: string[]
  custom_input?: string
}
