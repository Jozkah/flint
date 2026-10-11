/**
 * Cowork on a server session: the bridge between the server runner's events
 * (`remoteRunner.ts`) and the stores the Cowork page already reads.
 *
 * A remote session is an ordinary row of `useCoworkSessions` with
 * `remote: true`: its id is the server's session id, its transcript is
 * the server's (never written to this browser's storage), and its run is
 * mirrored into `useCoworkRun` the way a local run is, so the transcript, the
 * Stop button, the question cards and the "needs you" indicators work
 * unchanged. A local session never reaches this module: every entry point
 * checks `session.remote`, and `remote` rows can only be created while the
 * capability probe says the server runs sessions.
 *
 * What the stream gives that a local run did not: the permission prompts are
 * the *server's* (the file it would write is on that machine), so they are
 * raised directly and answered over the wire; this window's own standing
 * grants and permission mode never answer them.
 */
import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  applyInnerToTurns,
  attachAskToTurns,
  settleAskInTurns,
  useCoworkRun,
  type RunEnding,
  type StreamEvent,
} from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  useToolApprovalRequests,
  type ApprovalDecision,
  type PendingApproval,
} from '@/hooks/useToolApprovalRequests'
import { useMessageQueue } from '@/stores/message-queue-store'
import { beginRun, endRun, getRunHandle } from '@/lib/coworkRunner'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import { RustSubagentFeed } from '@/lib/rustSubagentFeed'
import { useRemoteWorktrees } from '@/lib/remoteWorktree'
import { isServerTransport } from '@/lib/serverTransportFlag'
import {
  answerRunAsk,
  approveRun,
  createRun,
  getRemoteSession,
  interruptRun,
  listRemoteSessions,
  probeRunner,
  startRun,
  steerRun,
  subscribeRun,
  type LiveEnvelope,
  type RemoteSession,
  type RunAccess,
  type RunnerInfo,
} from '@/lib/remoteRunner'
import type { AskAnswer, CoworkTurn, Usage } from '@/types/coworkSession'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** What a test (or a caller with its own transport) can replace. */
export type RemoteDeps = {
  fetchImpl?: FetchLike
  /** Milliseconds between looks at the composer's steering queue. */
  steerEveryMs?: number
}

/** How a finished remote turn is shown, in the vocabulary the route uses. */
function endingFor(payload: Record<string, unknown>): RunEnding | null {
  const reason = String(payload.stopReason ?? '')
  const error = typeof payload.error === 'string' ? payload.error : ''
  if (reason === 'interrupted') return { stoppedBy: 'aborted' }
  if (reason === 'error' || error) return { stoppedBy: 'error', errorText: error || 'The server run failed.' }
  return null
}

let cachedInfo: { at: number; info: RunnerInfo } | null = null

/** The probe, fresh enough to decide on and cheap to ask again. */
export async function runnerInfo(fetchImpl?: FetchLike, maxAgeMs = 30_000): Promise<RunnerInfo> {
  if (cachedInfo && Date.now() - cachedInfo.at < maxAgeMs && !fetchImpl) return cachedInfo.info
  const info = await probeRunner(fetchImpl)
  if (!fetchImpl) cachedInfo = { at: Date.now(), info }
  return info
}

export function forgetRunnerInfo(): void {
  cachedInfo = null
}

/** Whether a session is one the server runs. */
export function isRemoteSession(sid: string | null | undefined): boolean {
  if (!sid) return false
  return useCoworkSessions.getState().sessions.some((s) => s.id === sid && s.remote === true)
}

// ---------------------------------------------------------------------------
// The sessions list, read through from the server
// ---------------------------------------------------------------------------

function stubFor(row: RemoteSession): import('@/hooks/useCoworkSessions').CoworkSession {
  return {
    id: row.id,
    title: row.title || 'Server session',
    folder: row.folder,
    turns: [],
    messages: [],
    updated: row.updated ? row.updated * 1000 : Date.now(),
    createdAt: Date.now(),
    remote: true,
    // The mode a server session runs under is the server's, not this page's.
    mode: undefined,
  }
}

/**
 * Make the store's remote rows match the server's list: new ones appear (as
 * empty stubs, transcript fetched when opened), known ones are renamed, ones
 * the server no longer has are dropped. Local sessions are never touched.
 */
export function mergeRemoteRows(rows: RemoteSession[]): void {
  useCoworkSessions.setState((s) => {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const kept = s.sessions
      .filter((x) => !x.remote || byId.has(x.id))
      .map((x) => {
        const row = x.remote ? byId.get(x.id) : undefined
        if (!row) return x
        return { ...x, title: row.title || x.title, folder: row.folder ?? x.folder }
      })
    const known = new Set(kept.map((x) => x.id))
    const added = rows.filter((r) => !known.has(r.id)).map(stubFor)
    if (added.length === 0 && kept.length === s.sessions.length) {
      const same = kept.every((x, i) => x === s.sessions[i])
      if (same) return s
    }
    return { sessions: [...kept, ...added] }
  })
}

export async function syncRemoteSessions(fetchImpl?: FetchLike): Promise<RemoteSession[]> {
  const rows = await listRemoteSessions(fetchImpl)
  mergeRemoteRows(rows)
  return rows
}

/** Replace a remote session's transcript with the server's. */
export async function loadRemoteTranscript(sid: string, fetchImpl?: FetchLike): Promise<void> {
  const got = await getRemoteSession(sid, fetchImpl)
  const turns = (got.turns ?? []) as unknown as CoworkTurn[]
  commitTurns(sid, turns, { title: got.title, folder: got.folder })
}

function commitTurns(
  sid: string,
  turns: CoworkTurn[],
  extra: { title?: string; folder?: string | null; usage?: Usage } = {}
): void {
  useCoworkSessions.setState((s) => ({
    sessions: s.sessions.map((x) =>
      x.id === sid
        ? {
            ...x,
            turns,
            messages: coworkTurnsToUIMessages(turns, sid),
            updated: Date.now(),
            ...(extra.title ? { title: extra.title } : {}),
            ...(extra.folder !== undefined ? { folder: extra.folder } : {}),
            ...(extra.usage ? { lastUsage: extra.usage } : {}),
          }
        : x
    ),
  }))
}

// ---------------------------------------------------------------------------
// Creating a session on the server
// ---------------------------------------------------------------------------

/** Show a session the server holds (a coordinator it just made) as the current one. */
export async function openRemoteSession(id: string, fetchImpl?: FetchLike): Promise<void> {
  await syncRemoteSessions(fetchImpl)
  useCoworkSessions.setState({ currentId: id })
}

/** Start a session in `folder` on the server and open it as the current one. */
export async function startRemoteSession(
  input: {
    folder: string
    access?: RunAccess
    title?: string
    model?: string
    /** Omitted: isolated when it may write and the folder is a repository. */
    worktree?: boolean
  },
  fetchImpl?: FetchLike
): Promise<string> {
  const info = await runnerInfo(fetchImpl, 0)
  if (!info.runsSessions) {
    throw new Error(info.missing.length ? info.missing.join('; ') : 'This server does not run agents.')
  }
  const created = await createRun({ ...input, mode: 'cowork' }, fetchImpl)
  useCoworkSessions.setState((s) => ({
    sessions: [
      {
        id: created.id,
        title: input.title || 'Server session',
        folder: created.folder,
        turns: [],
        messages: [],
        updated: Date.now(),
        createdAt: Date.now(),
        remote: true,
      },
      ...s.sessions.filter((x) => x.id !== created.id),
    ],
    currentId: created.id,
  }))
  return created.id
}

// ---------------------------------------------------------------------------
// One server turn, mirrored into the run store
// ---------------------------------------------------------------------------

const live = new Map<string, RemoteRun>()

class RemoteRun {
  readonly controller = new AbortController()
  private readonly stream = new AbortController()
  private turns: CoworkTurn[]
  private readonly feed: RustSubagentFeed
  private readonly approvals = new Map<string, { local: PendingApproval; settled: boolean }>()
  private steerTimer: ReturnType<typeof setInterval> | undefined
  private ended = false
  private errorText: string | undefined
  private usage: Usage | undefined
  private interruptSent = false
  private dirty = false

  constructor(
    readonly sid: string,
    readonly runId: string,
    base: CoworkTurn[],
    private readonly deps: RemoteDeps,
    /** A run picked up mid-flight: its user message comes from the stream. */
    private readonly reattached = false
  ) {
    this.turns = base
    this.feed = new RustSubagentFeed({ sessionId: sid, runId })
  }

  // ---- lifecycle ---------------------------------------------------------

  begin(): void {
    const handle = beginRun(this.sid, this.runId, this.controller)
    useCoworkRun.getState().startRun(this.sid, this.runId)
    this.publish()
    live.set(this.sid, this)
    this.controller.signal.addEventListener('abort', () => void this.interrupt(), { once: true })
    this.steerTimer = setInterval(() => void this.steer(), this.deps.steerEveryMs ?? 600)
    void handle
  }

  /** Ask the server to stop the turn; the stream then delivers its end. */
  private async interrupt(): Promise<void> {
    if (this.ended || this.interruptSent) return
    this.interruptSent = true
    try {
      await interruptRun(this.sid, this.deps.fetchImpl)
    } catch {
      // Nothing to interrupt (not started yet, or already over): the stream or
      // the start call settles the run.
    }
  }

  subscribe(after: number): void {
    void subscribeRun(this.sid, {
      after,
      signal: this.stream.signal,
      fetchImpl: this.deps.fetchImpl,
      onEvents: (events) => {
        for (const env of events) this.handle(env)
        this.flush()
      },
      onGap: () => {
        // What was missed is in the transcript the turn will end with.
      },
    }).catch((e) => {
      if (!this.ended) this.fail(e instanceof Error ? e.message : String(e))
    })
  }

  /** The turn could not be started or followed. */
  fail(message: string): void {
    this.errorText = message
    void this.finish({ stopReason: 'error', error: message })
  }

  /** Make the start-time interrupt reach a turn that began after Stop. */
  async honourStopBeforeStart(): Promise<void> {
    if (this.controller.signal.aborted) {
      this.interruptSent = false
      await this.interrupt()
    }
  }

  // ---- steering ----------------------------------------------------------

  private async steer(): Promise<void> {
    if (this.ended) return
    const taken = useMessageQueue.getState().takeSteering(this.sid)
    for (const message of taken) {
      this.turns = [...this.turns, { role: 'user', content: message.text, steered: true }]
      this.dirty = true
      try {
        await steerRun(this.sid, message.text, this.deps.fetchImpl)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    }
    this.flush()
  }

  // ---- events ------------------------------------------------------------

  private handle(env: LiveEnvelope): void {
    const payload = (env.payload ?? {}) as Record<string, unknown>
    switch (env.kind) {
      case 'stream':
        this.stream_(payload as unknown as StreamEvent & Record<string, unknown>)
        return
      case 'turn.started':
        if (this.reattached && this.turns.length === 0 && typeof payload.input === 'string') {
          this.turns = [{ role: 'user', content: payload.input }]
          this.dirty = true
        }
        return
      case 'approval.resolved':
        this.resolvedElsewhere(String(payload.requestId ?? ''))
        return
      case 'ask.answered':
        this.askResolved(String(payload.requestId ?? ''), 'answered')
        return
      case 'turn.completed':
        void this.finish(payload)
        useRemoteWorktrees.getState().bump(this.sid)
        return
      case 'proposal.created':
        useRemoteWorktrees.getState().proposalCreated(this.sid, payload)
        return
      case 'proposal.error':
        useRemoteWorktrees.getState().proposalFailed(this.sid, String(payload.message ?? ''))
        return
      case 'worktree.changed':
      case 'worktree.discarded':
        useRemoteWorktrees.getState().bump(this.sid)
        return
      default:
        return
    }
  }

  private stream_(ev: StreamEvent & Record<string, unknown>): void {
    // The server also sends events the local loop never had (permission and
    // question bookkeeping), so the tag is read as a plain string.
    const raw = ev as Record<string, unknown>
    switch (raw.type as string) {
      case 'done': {
        const usage = raw.usage as Usage | null | undefined
        if (usage) {
          this.usage = usage
          useCoworkRun.getState().setUsage(this.sid, usage)
        }
        return
      }
      case 'error':
        this.errorText = String(raw.message ?? '')
        return
      case 'turn_usage':
        return
      case 'permission_request':
        this.raisePermission(raw)
        return
      case 'ask_request':
        this.raiseAsk(String(raw.request_id), raw.request as { questions: unknown[] })
        return
      case 'ask_resolved':
        this.askResolved(String(raw.request_id ?? ''), 'cancelled')
        return
      case 'subagent_queued':
      case 'subagent_start':
      case 'subagent_title':
      case 'subagent_end':
      case 'subagent_finished':
      case 'subagent':
        this.feed.apply(ev)
        return
      default: {
        const next = applyInnerToTurns(this.turns, ev)
        if (next !== this.turns) {
          this.turns = next
          this.dirty = true
        }
      }
    }
  }

  private flush(): void {
    if (!this.dirty || this.ended) return
    this.dirty = false
    this.publish()
  }

  private publish(): void {
    useCoworkRun.getState().setRunTurns(this.sid, this.runId, this.turns)
  }

  // ---- questions ---------------------------------------------------------

  private raiseAsk(requestId: string, request: { questions: unknown[] }): void {
    const record = {
      requestId,
      request: request as never,
      sessionId: this.sid,
      runId: this.runId,
      at: new Date().toISOString(),
      state: 'pending' as const,
    }
    this.turns = attachAskToTurns(this.turns, record)
    this.dirty = true
    useCoworkRun.getState().addPendingAsk(this.sid, requestId, request as never)
    const handle = getRunHandle(this.sid)
    handle?.pendingAsks.set(requestId, (answers: AskAnswer[] | null) => {
      this.turns = settleAskInTurns(
        this.turns,
        requestId,
        answers ? 'answered' : 'cancelled',
        answers ?? undefined
      )
      this.dirty = true
      useCoworkRun.getState().removePendingAsk(this.sid, requestId)
      this.flush()
      // A refusal to answer ends the wait on the server too, by stopping the turn.
      if (!answers) return
      void answerRunAsk(
        this.sid,
        requestId,
        answers.map((a) => ({ id: a.id, selected: a.selected, custom_input: a.custom_input })),
        this.deps.fetchImpl
      ).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
    })
  }

  private askResolved(requestId: string, state: 'answered' | 'cancelled'): void {
    if (!requestId) return
    const handle = getRunHandle(this.sid)
    if (handle?.pendingAsks.delete(requestId)) {
      this.turns = settleAskInTurns(this.turns, requestId, state)
      this.dirty = true
    }
    useCoworkRun.getState().removePendingAsk(this.sid, requestId)
  }

  // ---- permission prompts ------------------------------------------------

  private raisePermission(p: Record<string, unknown>): void {
    const serverId = String(p.request_id ?? '')
    if (!serverId || this.approvals.has(serverId)) return
    const tool = String(p.tool_name ?? 'tool')
    const where = typeof p.path === 'string' ? p.path : undefined
    const command = typeof p.command === 'string' ? p.command : undefined
    const diff = typeof p.diff === 'string' ? p.diff : undefined
    const offersAlways = p.offers_always === true
    let chosen: ApprovalDecision = 'deny'
    const entry: { local: PendingApproval; settled: boolean } = {
      settled: false,
      local: {
        requestId: `remote-${serverId}`,
        toolCallId: serverId,
        toolName: tool,
        threadId: this.sid,
        // Not the conversation's own agent: shown on its own, under no card.
        origin: 'server',
        // The command and the change are shown, but never passed as `input`:
        // a recognised input could be turned into a standing grant on this
        // machine for a call that runs on another.
        ...(diff ? { preview: diff } : command ? { preview: command } : {}),
        taskContext: `Runs on the server${where ? `: ${where}` : ''}.`,
        // Prompt only: `resolveApproval` records no standing grant for it.
        alwaysAsk: true,
        requestedAt: Date.now(),
        onDecision: (decision) => {
          chosen = decision
        },
        resolve: (approved) => {
          this.approvals.delete(serverId)
          if (entry.settled) return
          const answer =
            !approved ? 'deny' : chosen === 'allow-always' && offersAlways ? 'allow_always' : 'allow_once'
          void approveRun(this.sid, serverId, answer, this.deps.fetchImpl).catch((e) =>
            toast.error(e instanceof Error ? e.message : String(e))
          )
        },
      },
    }
    this.approvals.set(serverId, entry)
    useToolApprovalRequests.setState((s) =>
      s.pending[serverId]
        ? { queued: { ...s.queued, [serverId]: [...(s.queued[serverId] ?? []), entry.local] } }
        : { pending: { ...s.pending, [serverId]: entry.local } }
    )
  }

  /** Answered by another window, or timed out on the server. */
  private resolvedElsewhere(serverId: string): void {
    const entry = this.approvals.get(serverId)
    if (!entry) return
    entry.settled = true
    useToolApprovalRequests.getState().withdrawApproval(entry.local.requestId)
    this.approvals.delete(serverId)
  }

  // ---- the end -----------------------------------------------------------

  private async finish(payload: Record<string, unknown>): Promise<void> {
    if (this.ended) return
    this.ended = true
    if (this.steerTimer) clearInterval(this.steerTimer)
    this.stream.abort()
    for (const [serverId, entry] of [...this.approvals]) {
      entry.settled = true
      useToolApprovalRequests.getState().withdrawApproval(entry.local.requestId)
      this.approvals.delete(serverId)
    }
    // The server's transcript is the record; the live lane is only a preview.
    let committed = false
    try {
      await loadRemoteTranscript(this.sid, this.deps.fetchImpl)
      committed = true
    } catch {
      // Keep what streamed so the work is not lost from view.
    }
    const store = useCoworkSessions.getState()
    if (!committed) {
      const session = store.sessions.find((x) => x.id === this.sid)
      commitTurns(this.sid, [...(session?.turns ?? []), ...this.finalize()], {
        usage: this.usage,
      })
    } else if (this.usage) {
      useCoworkSessions.setState((s) => ({
        sessions: s.sessions.map((x) => (x.id === this.sid ? { ...x, lastUsage: this.usage } : x)),
      }))
    }
    const ending = endingFor({ ...payload, error: payload.error ?? this.errorText })
    useCoworkRun.getState().finishRun(this.sid, this.runId, ending)
    endRun(this.sid, this.runId)
    if (live.get(this.sid) === this) live.delete(this.sid)
    for (const record of useCoworkRun.getState().pendingAsks[this.sid] ?? []) {
      useCoworkRun.getState().removePendingAsk(this.sid, record.requestId)
    }
  }

  /** The preview turns, with calls still running marked as cut short. */
  private finalize(): CoworkTurn[] {
    return this.turns.map((t) =>
      t.role === 'tool' && t.status === 'running'
        ? { ...t, status: 'done' as const, isError: true, result: t.result || '(interrupted)', toolState: 'stale' as const }
        : t
    )
  }
}

/** The run for a session that has one in flight, for tests and Stop. */
export function remoteRunFor(sid: string): { runId: string } | undefined {
  const run = live.get(sid)
  return run ? { runId: run.runId } : undefined
}

/**
 * Send one message to a remote session. Returns when the turn has been handed
 * to the server (its events then arrive on their own); a refusal is thrown.
 */
export async function sendRemoteTurn(
  sid: string,
  text: string,
  deps: RemoteDeps = {}
): Promise<void> {
  // A local session never reaches the server runner.
  if (!isRemoteSession(sid)) throw new Error('That session is not a server session.')
  if (!isServerTransport() && !deps.fetchImpl) {
    throw new Error('Server sessions can only be run from a page the server serves.')
  }
  if (live.has(sid) || useCoworkRun.getState().runs[sid]) return
  const base: CoworkTurn[] = [{ role: 'user', content: text }]
  const run = new RemoteRun(sid, crypto.randomUUID(), base, deps)
  run.begin()
  try {
    const started = await startRun(sid, text, deps.fetchImpl)
    run.subscribe(started.after)
    await run.honourStopBeforeStart()
  } catch (e) {
    run.fail(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Pick up a turn the server is running that this page is not following (the
 * page was reloaded, or another device started it).
 */
export async function attachRemoteRun(
  sid: string,
  after: number,
  deps: RemoteDeps = {}
): Promise<void> {
  if (live.has(sid) || useCoworkRun.getState().runs[sid]) return
  const run = new RemoteRun(sid, crypto.randomUUID(), [], deps, true)
  run.begin()
  run.subscribe(after)
}

/**
 * Keep this page's view of the server's sessions current while the Cowork page
 * is open: the list, the opened session's transcript, and a turn that was
 * already running when the page came back. Does nothing off a server page.
 */
export function useRemoteCowork(): void {
  const server = isServerTransport()
  const currentId = useCoworkSessions((s) => s.currentId)
  useEffect(() => {
    if (!server) return
    let on = true
    const sync = () => {
      void syncRemoteSessions().catch(() => {
        // The review plane may be off; local sessions are unaffected.
      })
    }
    sync()
    const timer = setInterval(() => on && sync(), 30_000)
    return () => {
      on = false
      clearInterval(timer)
    }
  }, [server])
  useEffect(() => {
    if (!server || !currentId) return
    const session = useCoworkSessions.getState().sessions.find((x) => x.id === currentId)
    if (!session?.remote || useCoworkRun.getState().runs[currentId]) return
    let on = true
    void (async () => {
      try {
        const got = await getRemoteSession(currentId)
        if (!on) return
        const turns = (got.turns ?? []) as unknown as CoworkTurn[]
        if (turns.length > 0 || session.turns.length === 0) commitTurns(currentId, turns, { title: got.title })
        const running = (got as { status?: string }).status
        if (running && running !== 'idle' && (got as { live?: boolean }).live) {
          const turnAfter = Number((got as { turnAfter?: number }).turnAfter ?? (got as { lastSeq?: number }).lastSeq ?? 0)
          await attachRemoteRun(currentId, turnAfter)
          // Prompts that were already waiting when this page came back.
          // They arrive again through the stream's backlog.
        }
      } catch {
        // Not reachable: the page keeps what it has.
      }
    })()
    return () => {
      on = false
    }
  }, [server, currentId])
}
