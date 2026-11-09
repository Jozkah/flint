// The Cowork run store's shapes: run endings, the agent loop's stream events
// and the store's state.

import type { StoreApi } from 'zustand'
import type {
  AskAnswer,
  AskRecord,
  CoworkTurn,
  SubagentRun,
  Usage,
  TodoList,
  AskRequestPayload,
} from '@/types/coworkSession'
import type { ModelLoadProgress } from '@/hooks/useAppState'
import type { RunOutcome } from '@/lib/coworkRunner'
import type { RunEndedEvent } from '@/lib/runEnded'

/** How a session's run ended, as the route shows it. */
export type RunEnding = Pick<RunOutcome, 'stoppedBy' | 'errorText'>

// StreamEvent shapes emitted by the Rust agent loop (events.rs, tag = "type").
// Owned here because this store is what consumes/dispatches them.
export type StreamEvent =
  // AH-078. Carries the id and hash of the payload that was just dispatched,
  // never the payload itself: the timeline links to the stored record rather
  // than embedding a copy that could drift from it.
  | { type: 'prompt_snapshot'; id: string; hash: string; redactions: number }
  | { type: 'token'; text: string }
  | { type: 'step'; index: number; max: number }
  | { type: 'tool_call_started'; id: string; name: string }
  | { type: 'tool_call_args_delta'; id: string; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string; is_error: boolean; diff?: string }
  | { type: 'done'; stop_reason: string; usage: Usage | null }
  | { type: 'error'; code: string; message: string }
  | RunEndedEvent
  | { type: 'todo_update'; list: TodoList }
  | { type: 'ask_request'; request_id: string; request: AskRequestPayload }
  | { type: 'subagent_queued'; run_id: string; name: string; waiting: number }
  | { type: 'subagent_start'; run_id: string; name: string; task?: string }
  | { type: 'subagent_title'; run_id: string; name: string; title: string }
  | { type: 'subagent_end'; run_id: string; name: string; usage?: Usage | null }
  | {
      type: 'subagent_finished'
      run_id: string
      name: string
      status: 'done' | 'error' | 'turn_limit'
      usage?: Usage | null
      detail?: string
    }
  | { type: 'turn_usage'; usage: Usage }
  | { type: 'subagent'; run_id: string; name: string; event: StreamEvent }

// Transient (non-persisted) run state for the Cowork UI, keyed by session id —
// mirroring useAppState's per-thread Record<id, T> maps. This is what lets a run
// keep updating a background session while another is viewed: every stream write
// targets the session id captured at submit, and rendering reads the viewed id.
export type CoworkRunState = {
  liveTurns: Record<string, CoworkTurn[]>
  subagents: Record<string, SubagentRun[]>
  // In-flight `ask` tool questions per session. A subagent's wrapped ask is
  // attributed to the parent session the same way.
  pendingAsks: Record<string, { requestId: string; request: AskRequestPayload }[]>
  // Usage from the latest `done` event, per session. Set once per run (the
  // terminal event); untouched by a `null` usage so a provider that doesn't
  // report it on a given turn doesn't blank out the last known value.
  usage: Record<string, Usage>
  /**
   * The run each session has in flight, by session (janhq/jan#8905).
   *
   * What makes a session "running" -- not the page. Two sessions can each have
   * one, and a write that names a run the session no longer has is refused, so
   * a late event from a cancelled or replaced run cannot land anywhere.
   */
  runs: Record<string, { runId: string; startedAt: number }>
  /** How each session's last run ended, until it starts another. */
  outcomes: Record<string, RunEnding>
  /** Claim a session for a run: clears its last outcome, usage and lanes. */
  startRun: (sid: string, runId: string) => void
  /** Replace a run's live turns, if that run still owns the session. */
  setRunTurns: (sid: string, runId: string, turns: CoworkTurn[]) => void
  /** End a run and record how, if that run still owns the session. */
  finishRun: (sid: string, runId: string, ending: RunEnding | null) => void
  /** Drop everything held for a session, e.g. once it is deleted. */
  forgetSession: (sid: string) => void
  /** Set by the artifacts library so Cowork opens that file on mount. */
  pendingPreview: { sessionId: string; path: string } | null
  /**
   * Set by the file-activity view so Cowork shows a path it does not own:
   * `code` opens a read-only tab, `diff` focuses the Changes rail.
   */
  pendingCodeOpen: { sessionId: string; path: string; as: 'code' | 'diff' } | null
  /**
   * Somewhere outside Cowork asked for a folder to be opened in it.
   *
   * The native directory picker is the only way a session gets a folder, and
   * it lives in the Cowork route. Entry points elsewhere — the sidebar, the
   * collection dialog — raise this flag and navigate; the route opens the
   * picker and binds whatever the user chooses.
   */
  attachFolderRequested: boolean
  // Session ids currently talking to the llamacpp provider, mapped to the
  // model id in flight. Cowork sessions aren't chat threads, so they're
  // invisible to the chat-only signals the global OOM/backend-error listener
  // otherwise keys off; this is how that listener (mounted outside Cowork's
  // component tree, so it still sees a session running in the background)
  // finds the right session(s) to attribute a router-level failure to, and
  // matches load-progress events by model id rather than "whichever session
  // ran most recently".
  llamacppRuns: Record<string, string>
  // A friendlier failure message the listener stashes when the router itself
  // reports why (OOM / backend crash) — submitTurn prefers this over whatever
  // generic message the resulting connection failure produced.
  pendingLlamacppError: Record<string, string>
  // Cowork's own mirror of useAppState's thread-keyed loadingModels /
  // modelLoadProgressByThread, keyed by session id instead of chat thread id.
  // Kept as an entirely separate Record rather than sharing chat's — several
  // chat-side functions (hasActiveLlamacppRequest, clearActiveWork) scan
  // useAppState.loadingModels' *keys* as their "is a real chat thread active"
  // signal; writing Cowork session ids into that same Record would make a
  // Cowork-only model load/failure look like chat activity to those checks.
  loadingModels: Record<string, boolean>
  modelLoadProgress: Record<string, ModelLoadProgress>

  appendToken: (sid: string, text: string) => void
  pushToolTurn: (sid: string, turn: CoworkTurn) => void
  updateToolTurn: (sid: string, callId: string, patch: Partial<CoworkTurn>) => void
  // `tool_call_started`: open a live tool row before any args exist, so the
  // card shows a spot the user can watch fill as the arguments stream.
  announceToolCall: (sid: string, id: string, name: string) => void
  // `tool_call_args_delta`: append raw JSON argument text to the running row.
  appendToolArgs: (sid: string, id: string, delta: string) => void
  /** Empty a session's subagent lanes at the start of a run, so the panel shows
   * this run's children rather than every child the session ever had. */
  resetSubagents: (sid: string) => void
  startSubagent: (sid: string, runId: string, name: string) => void
  // `subagent_queued`: mark a child as waiting for a concurrency slot.
  queueSubagent: (sid: string, runId: string, name: string, waiting: number) => void
  endSubagent: (sid: string, runId: string, usage?: Usage | null) => void
  routeIntoSubagent: (sid: string, runId: string, inner: StreamEvent) => void
  attachSubagentOutput: (sid: string, runId: string, content: string) => void
  setUsage: (sid: string, usage: Usage | null) => void
  requestPreview: (sessionId: string, path: string) => void
  requestCodeOpen: (
    sessionId: string,
    path: string,
    as: 'code' | 'diff'
  ) => void
  clearPendingCodeOpen: () => void
  /** Ask the Cowork route to open the native directory picker. */
  requestAttachFolder: () => void
  clearAttachFolderRequest: () => void
  clearPendingPreview: () => void
  setLlamacppRun: (sid: string, modelId: string) => void
  clearLlamacppRun: (sid: string) => void
  setPendingLlamacppError: (sid: string, message: string) => void
  /** Reads and clears in one step, so a message can't be applied twice. */
  takePendingLlamacppError: (sid: string) => string | undefined
  setSessionLoadingModel: (sid: string, loading: boolean) => void
  setSessionModelLoadProgress: (
    sid: string,
    progress: ModelLoadProgress | undefined
  ) => void
  addPendingAsk: (sid: string, requestId: string, request: AskRequestPayload) => void
  removePendingAsk: (sid: string, requestId: string) => void
  /** Put a question in the transcript at the point it was asked. */
  attachAsk: (sid: string, record: AskRecord) => void
  /** Record what the model was sent, on the turn its reply appears in. */
  attachPromptSnapshot: (
    sid: string,
    ref: { id: string; hash: string; redactions: number }
  ) => void
  /**
   * Every dispatch this session has made, in order.
   *
   * Kept beside the turns rather than on them: the run rebuilds its live turn
   * array as steps complete, and a reference written onto a turn at dispatch
   * time does not survive that. The Nth entry belongs to the Nth model
   * invocation, which is what the timeline zips against.
   */
  promptSnapshots: Record<
    string,
    { id: string; hash: string; redactions: number }[]
  >
  recordPromptSnapshot: (
    sid: string,
    ref: { id: string; hash: string; redactions: number }
  ) => void
  /** Record what became of a question, in place, without moving it. */
  settleAsk: (
    sid: string,
    requestId: string,
    state: AskRecord['state'],
    answers?: AskAnswer[]
  ) => void
  // Mark running tool turns + subagents done (interrupted). Leaves
  // liveTurns/subagents in place and returns the final values so the caller
  // can commit them before clearCodeRun without a second round of store
  // reads. Run-level failure is surfaced separately via `useMessageErrors`,
  // not through this function.
  finalizeRun: (sid: string) => { turns: CoworkTurn[]; subagents: SubagentRun[] }
  clearCodeRun: (sid: string) => void
}

export type SetRun = StoreApi<CoworkRunState>['setState']
