import { create } from 'zustand'
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

/** How a session's run ended, as the route shows it. */
export type RunEnding = Pick<RunOutcome, 'stoppedBy' | 'errorText'>

// The ask shapes live in the store-free types module; re-exported here because
// this store is where the pending-ask queue lives.
export type {
  AskOption,
  AskQuestion,
  AskRequestPayload,
  AskAnswer,
  AskRecord,
} from '@/types/coworkSession'

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
  | { type: 'todo_update'; list: TodoList }
  | { type: 'ask_request'; request_id: string; request: AskRequestPayload }
  | { type: 'subagent_queued'; run_id: string; name: string; waiting: number }
  | { type: 'subagent_start'; run_id: string; name: string; task?: string }
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

// Append a streamed token to the last assistant turn, or start a new one.
// Shared by the main stream (appendToken) and a subagent's wrapped stream
// (applyInnerToTurns) — same merge, different turn lane.
function appendAssistantToken(turns: CoworkTurn[], text: string): CoworkTurn[] {
  const last = turns[turns.length - 1]
  if (last && last.role === 'assistant')
    return [...turns.slice(0, -1), { ...last, content: last.content + text }]
  return [...turns, { role: 'assistant', content: text }]
}

// A freshly-dispatched tool call's turn. Shared by the main stream's
// pushToolTurn call site (cowork.tsx) and a subagent's wrapped tool_call.
export function makeToolCallTurn(ev: {
  id: string
  name: string
  args: unknown
}): CoworkTurn {
  return {
    role: 'tool',
    content: '',
    callId: ev.id,
    name: ev.name,
    args: ev.args,
    status: 'running',
    // The durable item begins here and is never replaced: the result merges
    // onto this same turn.
    toolState: 'running',
    startedAt: Date.now(),
  }
}

/**
 * Which terminal state an error result belongs in.
 *
 * A refusal and a cancellation are not failures -- they are outcomes the user
 * or the permission gate chose -- and the timeline has to keep saying which,
 * because "failed" would read as the tool having gone wrong.
 */
export function toolOutcome(
  isError: boolean,
  content: string
): 'succeeded' | 'failed' | 'cancelled' | 'refused' {
  if (!isError) return 'succeeded'
  const text = content.toLowerCase()
  if (text.includes('cancelled') || text.includes('canceled') || text.includes('interrupted')) {
    return 'cancelled'
  }
  if (
    text.includes('refused') ||
    text.includes('denied') ||
    text.includes('not permitted') ||
    text.includes('permission')
  ) {
    return 'refused'
  }
  return 'failed'
}

// Find the tool turn by callId and merge patch onto it; returns the same
// array reference (no-op) when there's no match, so callers can cheaply
// detect "nothing changed". Shared by updateToolTurn and applyInnerToTurns.
function mergeToolResult(
  turns: CoworkTurn[],
  callId: string,
  patch: Partial<CoworkTurn>
): CoworkTurn[] {
  const idx = turns.findIndex((tn) => tn.role === 'tool' && tn.callId === callId)
  if (idx === -1) return turns
  return [...turns.slice(0, idx), { ...turns[idx], ...patch }, ...turns.slice(idx + 1)]
}

/**
 * Put a question on the assistant turn that was speaking when it was asked.
 *
 * Pure, because there are two live-turn lanes: this store, and the Cowork
 * route's own ref-backed copy that it actually renders. Both have to apply the
 * same rule, and a rule that lives in one store action is a rule the other
 * lane silently does not have.
 */
export function attachAskToTurns(
  turns: CoworkTurn[],
  record: AskRecord
): CoworkTurn[] {
  if (turns.some((t) => t.asks?.some((a) => a.requestId === record.requestId))) {
    return turns
  }
  // The assistant turn, not the tool turn: a tool turn is the call itself, and
  // hanging the card off it would put the question inside the tool card.
  let idx = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      idx = i
      break
    }
  }
  if (idx === -1) {
    return [...turns, { role: 'assistant', content: '', asks: [record] }]
  }
  return [
    ...turns.slice(0, idx),
    { ...turns[idx], asks: [...(turns[idx].asks ?? []), record] },
    ...turns.slice(idx + 1),
  ]
}

/** Record what became of a question, in place, without moving it. */
export function settleAskInTurns(
  turns: CoworkTurn[],
  requestId: string,
  state: AskRecord['state'],
  answers?: AskAnswer[]
): CoworkTurn[] {
  let changed = false
  const next = turns.map((turn) => {
    if (!turn.asks?.some((a) => a.requestId === requestId)) return turn
    changed = true
    return {
      ...turn,
      asks: turn.asks.map((a) =>
        a.requestId === requestId ? { ...a, state, answers } : a
      ),
    }
  })
  return changed ? next : turns
}

/**
 * Put a prompt snapshot on the turn whose reply that request produced.
 *
 * The dispatch happens before the reply streams, so the turn it belongs to is
 * the open assistant turn -- or a new one, which the reply is then appended to.
 */
export function attachPromptSnapshotToTurns(
  turns: CoworkTurn[],
  ref: { id: string; hash: string; redactions: number }
): CoworkTurn[] {
  if (turns.some((t) => t.promptSnapshot?.id === ref.id)) return turns
  const last = turns[turns.length - 1]
  if (last?.role === 'assistant' && !last.promptSnapshot && !last.content) {
    return [...turns.slice(0, -1), { ...last, promptSnapshot: ref }]
  }
  return [...turns, { role: 'assistant', content: '', promptSnapshot: ref }]
}

// Apply one wrapped inner subagent event to that subagent's own turn lane
// (token append / tool_call push / tool_result merge). Pure.
/** Exported so the event-to-turn mapping is testable on its own. */
export function applyInnerToTurns(turns: CoworkTurn[], inner: StreamEvent): CoworkTurn[] {
  switch (inner.type) {
    case 'token':
      return appendAssistantToken(turns, inner.text)
    case 'tool_call_started': {
      if (turns.some((tn) => tn.role === 'tool' && tn.callId === inner.id)) return turns
      return [
        ...turns,
        {
          role: 'tool',
          content: '',
          callId: inner.id,
          name: inner.name,
          args: null,
          argsLive: '',
          status: 'running',
          // Named before its arguments have finished streaming: the item
          // exists from the moment the call was requested.
          toolState: 'requested',
          startedAt: Date.now(),
        },
      ]
    }
    case 'tool_call_args_delta': {
      const idx = turns.findIndex((tn) => tn.role === 'tool' && tn.callId === inner.id)
      if (idx === -1) return turns
      const prev = turns[idx].argsLive ?? ''
      return [...turns.slice(0, idx), { ...turns[idx], argsLive: prev + inner.delta }, ...turns.slice(idx + 1)]
    }
    case 'prompt_snapshot': {
      // Arrives immediately before the model streams its reply, so it opens the
      // assistant turn that reply will be appended to. That is what ties a
      // snapshot to the invocation it belongs to.
      const last = turns[turns.length - 1]
      if (last?.role === 'assistant' && !last.promptSnapshot && !last.content) {
        return [
          ...turns.slice(0, -1),
          {
            ...last,
            promptSnapshot: {
              id: inner.id,
              hash: inner.hash,
              redactions: inner.redactions,
            },
          },
        ]
      }
      return [
        ...turns,
        {
          role: 'assistant',
          content: '',
          promptSnapshot: {
            id: inner.id,
            hash: inner.hash,
            redactions: inner.redactions,
          },
        },
      ]
    }
    case 'tool_call': {
      // The call may already be here from `tool_call_started`; that turn is
      // advanced rather than duplicated.
      const idx = turns.findIndex(
        (tn) => tn.role === 'tool' && tn.callId === inner.id
      )
      if (idx !== -1) {
        return [
          ...turns.slice(0, idx),
          {
            ...turns[idx],
            args: inner.args,
            argsLive: undefined,
            toolState: 'running',
          },
          ...turns.slice(idx + 1),
        ]
      }
      return [...turns, makeToolCallTurn(inner)]
    }
    case 'tool_result':
      return mergeToolResult(turns, inner.id, {
        result: inner.content,
        isError: inner.is_error,
        diff: inner.diff,
        status: 'done',
        // The same item, in a terminal state. Nothing is removed and no
        // separate result item is appended.
        toolState: toolOutcome(inner.is_error, inner.content),
        endedAt: Date.now(),
      })
    default:
      return turns // step / anything else: no visible turn
  }
}

function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

// Transient (non-persisted) run state for the Cowork UI, keyed by session id —
// mirroring useAppState's per-thread Record<id, T> maps. This is what lets a run
// keep updating a background session while another is viewed: every stream write
// targets the session id captured at submit, and rendering reads the viewed id.
type CoworkRunState = {
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

export const useCoworkRun = create<CoworkRunState>()((set, get) => ({
  liveTurns: {},
  subagents: {},
  pendingAsks: {},
  promptSnapshots: {},
  usage: {},
  runs: {},
  outcomes: {},

  startRun: (sid, runId) =>
    set((s) => ({
      runs: { ...s.runs, [sid]: { runId, startedAt: Date.now() } },
      outcomes: omitKey(s.outcomes, sid),
      usage: omitKey(s.usage, sid),
      liveTurns: { ...s.liveTurns, [sid]: [] },
      subagents: { ...s.subagents, [sid]: [] },
    })),

  setRunTurns: (sid, runId, turns) =>
    set((s) =>
      s.runs[sid]?.runId === runId
        ? { liveTurns: { ...s.liveTurns, [sid]: turns } }
        : {}
    ),

  finishRun: (sid, runId, ending) =>
    set((s) => {
      if (s.runs[sid]?.runId !== runId) return {}
      return {
        runs: omitKey(s.runs, sid),
        outcomes: ending
          ? { ...s.outcomes, [sid]: ending }
          : omitKey(s.outcomes, sid),
        liveTurns: omitKey(s.liveTurns, sid),
      }
    }),

  forgetSession: (sid) =>
    set((s) => ({
      runs: omitKey(s.runs, sid),
      outcomes: omitKey(s.outcomes, sid),
      liveTurns: omitKey(s.liveTurns, sid),
      usage: omitKey(s.usage, sid),
      subagents: omitKey(s.subagents, sid),
      pendingAsks: omitKey(s.pendingAsks, sid),
      promptSnapshots: omitKey(s.promptSnapshots, sid),
      llamacppRuns: omitKey(s.llamacppRuns, sid),
      pendingLlamacppError: omitKey(s.pendingLlamacppError, sid),
      loadingModels: omitKey(s.loadingModels, sid),
      modelLoadProgress: omitKey(s.modelLoadProgress, sid),
    })),

  pendingPreview: null,
  pendingCodeOpen: null,
  attachFolderRequested: false,
  llamacppRuns: {},
  pendingLlamacppError: {},
  loadingModels: {},
  modelLoadProgress: {},

  appendToken: (sid, text) =>
    set((s) => ({
      liveTurns: {
        ...s.liveTurns,
        [sid]: appendAssistantToken(s.liveTurns[sid] ?? [], text),
      },
    })),

  pushToolTurn: (sid, turn) =>
    set((s) => ({
      liveTurns: { ...s.liveTurns, [sid]: [...(s.liveTurns[sid] ?? []), turn] },
    })),

  updateToolTurn: (sid, callId, patch) =>
    set((s) => {
      const turns = s.liveTurns[sid] ?? []
      const next = mergeToolResult(turns, callId, patch)
      return next === turns ? {} : { liveTurns: { ...s.liveTurns, [sid]: next } }
    }),

  announceToolCall: (sid, id, name) =>
    set((s) => {
      const turns = s.liveTurns[sid] ?? []
      if (turns.some((tn) => tn.role === 'tool' && tn.callId === id)) return {}
      return {
        liveTurns: {
          ...s.liveTurns,
          [sid]: [
            ...turns,
            { role: 'tool', content: '', callId: id, name, args: null, argsLive: '', status: 'running' },
          ],
        },
      }
    }),

  appendToolArgs: (sid, id, delta) =>
    set((s) => {
      const turns = s.liveTurns[sid] ?? []
      const idx = turns.findIndex((tn) => tn.role === 'tool' && tn.callId === id)
      if (idx === -1) return {}
      const prev = turns[idx].argsLive ?? ''
      return {
        liveTurns: {
          ...s.liveTurns,
          [sid]: [...turns.slice(0, idx), { ...turns[idx], argsLive: prev + delta }, ...turns.slice(idx + 1)],
        },
      }
    }),

  resetSubagents: (sid) =>
    set((s) => ({ subagents: { ...s.subagents, [sid]: [] } })),

  startSubagent: (sid, runId, name) =>
    set((s) => {
      const runs = s.subagents[sid] ?? []
      // Promote a queued child the moment its slot frees; otherwise create it.
      const idx = runs.findIndex((r) => r.runId === runId)
      if (idx !== -1) {
        const existing = runs[idx]
        if (existing.status === 'queued') {
          return {
            subagents: {
              ...s.subagents,
              [sid]: [
                ...runs.slice(0, idx),
                { ...existing, status: 'running' as const, waiting: undefined, startedAt: Date.now() },
                ...runs.slice(idx + 1),
              ],
            },
          }
        }
        return {}
      }
      return {
        subagents: {
          ...s.subagents,
          [sid]: [
            ...runs,
            { runId, name, status: 'running', startedAt: Date.now(), turns: [] },
          ],
        },
      }
    }),

  queueSubagent: (sid, runId, name, waiting) =>
    set((s) => {
      const runs = s.subagents[sid] ?? []
      if (runs.some((r) => r.runId === runId)) return {}
      return {
        subagents: {
          ...s.subagents,
          [sid]: [
            ...runs,
            { runId, name, status: 'queued', waiting, startedAt: Date.now(), turns: [] },
          ],
        },
      }
    }),


  endSubagent: (sid, runId, usage) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [sid]: (s.subagents[sid] ?? []).map((r) =>
          r.runId === runId && r.status !== 'done'
            ? {
                ...r,
                status: 'done' as const,
                endedAt: Date.now(),
                usage: usage ?? undefined,
              }
            : r
        ),
      },
    })),

  routeIntoSubagent: (sid, runId, inner) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [sid]: (s.subagents[sid] ?? []).map((r) =>
          r.runId === runId ? { ...r, turns: applyInnerToTurns(r.turns, inner) } : r
        ),
      },
    })),

  attachSubagentOutput: (sid, runId, content) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [sid]: (s.subagents[sid] ?? []).map((r) =>
          r.runId === runId && r.finalOutput == null ? { ...r, finalOutput: content } : r
        ),
      },
    })),

  setUsage: (sid, usage) =>
    set((s) => (usage ? { usage: { ...s.usage, [sid]: usage } } : {})),

  requestPreview: (sessionId, path) => set({ pendingPreview: { sessionId, path } }),
  clearPendingPreview: () => set({ pendingPreview: null }),
  requestCodeOpen: (sessionId, path, as) =>
    set({ pendingCodeOpen: { sessionId, path, as } }),
  clearPendingCodeOpen: () => set({ pendingCodeOpen: null }),
  requestAttachFolder: () => set({ attachFolderRequested: true }),
  clearAttachFolderRequest: () => set({ attachFolderRequested: false }),

  setLlamacppRun: (sid, modelId) =>
    set((s) => ({ llamacppRuns: { ...s.llamacppRuns, [sid]: modelId } })),
  clearLlamacppRun: (sid) =>
    set((s) => ({ llamacppRuns: omitKey(s.llamacppRuns, sid) })),
  setPendingLlamacppError: (sid, message) =>
    set((s) => ({
      pendingLlamacppError: { ...s.pendingLlamacppError, [sid]: message },
    })),
  takePendingLlamacppError: (sid) => {
    const message = get().pendingLlamacppError[sid]
    if (message !== undefined) {
      set((s) => ({ pendingLlamacppError: omitKey(s.pendingLlamacppError, sid) }))
    }
    return message
  },
  setSessionLoadingModel: (sid, loading) =>
    set((s) => {
      const next = { ...s.loadingModels }
      if (loading) next[sid] = true
      else delete next[sid]
      return { loadingModels: next }
    }),
  setSessionModelLoadProgress: (sid, progress) =>
    set((s) => {
      const next = { ...s.modelLoadProgress }
      if (progress) next[sid] = progress
      else delete next[sid]
      return { modelLoadProgress: next }
    }),

  addPendingAsk: (sid, requestId, request) =>
    set((s) => ({
      pendingAsks: {
        ...s.pendingAsks,
        [sid]: [...(s.pendingAsks[sid] ?? []), { requestId, request }],
      },
    })),

  removePendingAsk: (sid, requestId) =>
    set((s) => ({
      pendingAsks: {
        ...s.pendingAsks,
        [sid]: (s.pendingAsks[sid] ?? []).filter((a) => a.requestId !== requestId),
      },
    })),

  attachAsk: (sid, record) =>
    set((st) => ({
      liveTurns: {
        ...st.liveTurns,
        [sid]: attachAskToTurns(st.liveTurns[sid] ?? [], record),
      },
    })),

  recordPromptSnapshot: (sid, ref) =>
    set((st) => {
      const seen = st.promptSnapshots[sid] ?? []
      if (seen.some((s) => s.id === ref.id)) return {}
      return {
        promptSnapshots: { ...st.promptSnapshots, [sid]: [...seen, ref] },
      }
    }),

  attachPromptSnapshot: (sid, ref) =>
    set((st) => ({
      liveTurns: {
        ...st.liveTurns,
        [sid]: attachPromptSnapshotToTurns(st.liveTurns[sid] ?? [], ref),
      },
    })),

  settleAsk: (sid, requestId, state, answers) =>
    set((st) => ({
      liveTurns: {
        ...st.liveTurns,
        [sid]: settleAskInTurns(
          st.liveTurns[sid] ?? [],
          requestId,
          state,
          answers
        ),
      },
    })),

  finalizeRun: (sid) => {
    // Run-level failure surfaces via `useMessageErrors` (Generation-failed
    // banner), not as a synthetic tool-error turn — that used to render a
    // misleading error-styled tool card even though no tool call failed.
    const turns: CoworkTurn[] = (get().liveTurns[sid] ?? []).map((tn) =>
      tn.role === 'tool' && tn.status === 'running'
        ? {
            ...tn,
            status: 'done' as const,
            isError: true,
            result: tn.result || '(interrupted)',
            // The run that would have finished this call is gone.
            toolState: 'stale' as const,
            endedAt: Date.now(),
          }
        : tn
    )
    const subs = (get().subagents[sid] ?? []).map((r) =>
      r.status !== 'done' ? { ...r, status: 'done' as const, endedAt: Date.now() } : r
    )
    set((s) => ({
      liveTurns: { ...s.liveTurns, [sid]: turns },
      subagents: { ...s.subagents, [sid]: subs },
    }))
    return { turns, subagents: subs }
  },

  clearCodeRun: (sid) =>
    set((s) => ({
      liveTurns: omitKey(s.liveTurns, sid),
      subagents: omitKey(s.subagents, sid),
      pendingAsks: omitKey(s.pendingAsks, sid),
      usage: omitKey(s.usage, sid),
      llamacppRuns: omitKey(s.llamacppRuns, sid),
      pendingLlamacppError: omitKey(s.pendingLlamacppError, sid),
      loadingModels: omitKey(s.loadingModels, sid),
      modelLoadProgress: omitKey(s.modelLoadProgress, sid),
    })),
}))

