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
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  attachAskToTurns,
  settleAskInTurns,
  useCoworkRun,
  type RunEnding,
} from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useModelProvider } from '@/hooks/useModelProvider'
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
import { mapRemoteEvent } from '@/lib/remoteEventMapper'
import { isServerTransport } from '@/lib/serverTransportFlag'
import { describeSpendPause } from '@/lib/spendPause'
import { i18n } from '@/i18n/react-i18next-compat'
import {
  answerRunAsk,
  approveRun,
  createRun,
  getRemoteSession,
  interruptRun,
  listRemoteSessions,
  probeRunner,
  setRunAccess,
  startRun,
  type RunAttachment,
  steerRun,
  subscribeRun,
  type LiveEnvelope,
  type RemoteSession,
  type RunAccess,
  type RunnerInfo,
} from '@/lib/remoteRunner'
import type { AskAnswer, CoworkTurn, Usage } from '@/types/coworkSession'
import { COWORK_MODES, type CoworkMode } from '@/lib/coworkMode'
import { DEFAULT_SESSION_TITLE } from '@/lib/coworkSessionStart'

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

/** The server's title, unless it is only the session id (an unnamed session). */
function titleOf(row: { id: string; title?: string | null }): string {
  return row.title && row.title.trim() && row.title !== row.id ? row.title : ''
}

const TITLE_MAX = 60
/** Titles a server session carries before it has a real one. */
const PLACEHOLDER_TITLES = new Set([DEFAULT_SESSION_TITLE, 'Server session'])

/**
 * A readable title for a server session: the server's own, else the first
 * thing the user said (as a desktop session is titled), else "New session".
 * Never the bare session id the server reports for an unnamed session.
 */
export function remoteSessionTitle(
  id: string,
  title: string | null | undefined,
  turns: ReadonlyArray<{ role: string; content: unknown }> = []
): string {
  const named = titleOf({ id, title })
  if (named) return named
  const first = turns.find(
    (t) => t.role === 'user' && typeof t.content === 'string' && t.content.trim()
  )
  if (first) {
    const line = String(first.content).trim().split(/\r?\n/)[0].trim()
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
  }
  return DEFAULT_SESSION_TITLE
}

function stubFor(row: RemoteSession): import('@/hooks/useCoworkSessions').CoworkSession {
  return {
    id: row.id,
    title: remoteSessionTitle(row.id, row.title),
    folder: row.folder,
    turns: [],
    messages: [],
    updated: row.updated ? row.updated * 1000 : Date.now(),
    createdAt: Date.now(),
    remote: true,
    remoteStatus: row.status,
    remoteModel: row.model,
    ...(row.access ? { remoteAccess: row.access } : {}),
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
        const title = titleOf(row) || x.title
        const folder = row.folder ?? x.folder
        const remoteAccess = row.access ?? x.remoteAccess
        if (
          title === x.title &&
          folder === x.folder &&
          row.status === x.remoteStatus &&
          row.model === x.remoteModel &&
          remoteAccess === x.remoteAccess
        )
          return x
        return {
          ...x,
          title,
          folder,
          remoteStatus: row.status,
          remoteModel: row.model,
          ...(remoteAccess ? { remoteAccess } : {}),
        }
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
            ...titleUpdate(x, extra.title, turns),
            ...(extra.folder !== undefined ? { folder: extra.folder } : {}),
            ...(extra.usage ? { lastUsage: extra.usage } : {}),
          }
        : x
    ),
  }))
}

/**
 * The title to store with a committed transcript: the server's when it named
 * the session, else one derived from the first message while the row still
 * carries a placeholder (or the bare id). A title already readable is kept.
 */
function titleUpdate(
  x: { id: string; title: string },
  given: string | undefined,
  turns: CoworkTurn[]
): { title?: string } {
  const named = given ? titleOf({ id: x.id, title: given }) : ''
  if (named) return { title: named }
  if (x.title && x.title !== x.id && !PLACEHOLDER_TITLES.has(x.title)) return {}
  const derived = remoteSessionTitle(x.id, null, turns as Array<{ role: string; content: unknown }>)
  return derived === x.title ? {} : { title: derived }
}

// ---------------------------------------------------------------------------
// The access a server session runs with (its "mode")
// ---------------------------------------------------------------------------

/** The server's word for a Cowork mode. */
export function modeToAccess(mode: CoworkMode): RunAccess {
  return mode === 'review' ? 'read' : mode
}

/** The Cowork mode for the server's access word, when it is one. */
export function accessToMode(access: string | null | undefined): CoworkMode | undefined {
  if (!access) return undefined
  const word = access === 'read' ? 'review' : access
  return (COWORK_MODES as readonly string[]).includes(word) ? (word as CoworkMode) : undefined
}

/**
 * The mode a session on a server page is shown in. A server session shows
 * what the server last said it runs with, so the picker and the server cannot
 * disagree; before that is known, the user's choice, else `ask`, the server's
 * own default. Never `auto` by default: a server only allows it when started
 * with `--agent-allow-bypass`.
 */
export function serverPageMode(
  session: { mode?: CoworkMode; remote?: boolean; remoteAccess?: string } | undefined
): CoworkMode {
  if (session?.remote) return accessToMode(session.remoteAccess) ?? session.mode ?? 'ask'
  return session?.mode ?? 'ask'
}

/** The modes a session may be put in on this server. */
export function allowedRemoteModes(
  info: Pick<RunnerInfo, 'allowBypass'> | null | undefined
): CoworkMode[] {
  return info?.allowBypass ? [...COWORK_MODES] : ['review', 'ask']
}

/** `runnerInfo`'s answer for a component: null until the probe lands. */
export function useRunnerInfo(enabled: boolean): RunnerInfo | null {
  const [info, setInfo] = useState<RunnerInfo | null>(cachedInfo?.info ?? null)
  useEffect(() => {
    if (!enabled) return
    let on = true
    runnerInfo()
      .then((got) => on && setInfo(got))
      .catch(() => {})
    return () => {
      on = false
    }
  }, [enabled])
  return info
}

function recordAccess(sid: string, mode: CoworkMode, access: string): void {
  useCoworkSessions.setState((s) => ({
    sessions: s.sessions.map((x) => (x.id === sid ? { ...x, mode, remoteAccess: access } : x)),
  }))
}

/**
 * Put a server session in `mode` on the server, and record what the server
 * answered as the session's effective access. Throws when the server refuses
 * (a mode it does not allow, a turn in progress); the session is unchanged.
 */
export async function setRemoteMode(
  sid: string,
  mode: CoworkMode,
  fetchImpl?: FetchLike
): Promise<CoworkMode> {
  const out = await setRunAccess(sid, modeToAccess(mode), fetchImpl)
  const access = typeof out?.access === 'string' ? out.access : modeToAccess(mode)
  const effective = accessToMode(access) ?? mode
  recordAccess(sid, effective, access)
  return effective
}

/**
 * Before a turn: a mode chosen on this page that the server does not have yet
 * (picked before the session existed, or a change that did not reach it) is
 * sent first, so the run cannot start under a different access.
 */
export async function syncRemoteMode(sid: string, fetchImpl?: FetchLike): Promise<void> {
  const session = useCoworkSessions.getState().sessions.find((x) => x.id === sid)
  if (!session?.remote || !session.mode) return
  if (modeToAccess(session.mode) === session.remoteAccess) return
  await setRemoteMode(sid, session.mode, fetchImpl)
}

// ---------------------------------------------------------------------------
// Creating a session on the server
// ---------------------------------------------------------------------------

/** Show a session the server holds (a coordinator it just made) as the current one. */
export async function openRemoteSession(id: string, fetchImpl?: FetchLike): Promise<void> {
  await syncRemoteSessions(fetchImpl)
  useCoworkSessions.setState({ currentId: id })
}

/**
 * The model the browser has selected, when it is one the server can run (a
 * provider the browser added; the server has no local engine for this page).
 */
export function selectedServerModel(): string | undefined {
  const { selectedModel, selectedProvider } = useModelProvider.getState()
  if (!selectedModel?.id || !selectedProvider || selectedProvider === 'llamacpp') return undefined
  return selectedModel.id
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
  // The model travels with the request: the one asked for, else the browser's
  // selection (what the server would default to), so the two cannot drift.
  const model = input.model ?? selectedServerModel()
  const created = await createRun(
    { ...input, ...(model ? { model } : {}), mode: 'cowork' },
    fetchImpl
  )
  const createdMode = accessToMode(created.access ?? input.access)
  useCoworkSessions.setState((s) => ({
    sessions: [
      {
        id: created.id,
        title: input.title?.trim() || DEFAULT_SESSION_TITLE,
        folder: created.folder,
        turns: [],
        messages: [],
        updated: Date.now(),
        createdAt: Date.now(),
        remote: true,
        remoteStatus: 'idle' as const,
        remoteModel: model ?? null,
        ...(created.access ? { remoteAccess: created.access } : {}),
        ...(createdMode ? { mode: createdMode } : {}),
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
  private steering = false
  /** Resolves when the turn has been fully settled (transcript committed). */
  readonly settled: Promise<void>
  private resolveSettled!: () => void

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
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve
    })
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
      onGap: () => void this.resync(),
      onReset: () => void this.resetAndResync(),
    }).catch((e) => {
      if (!this.ended) this.fail(e instanceof Error ? e.message : String(e))
    })
  }

  /**
   * Events were missed: prompts that arrived in the gap are re-raised from the
   * session's pending lists (already known ones are skipped by request id).
   */
  private async resync(): Promise<void> {
    if (this.ended) return
    try {
      const session = await getRemoteSession(this.sid, this.deps.fetchImpl)
      if (this.ended) return
      for (const rec of session.pendingApprovals ?? []) this.raisePermission(rec)
      for (const rec of session.pendingAsks ?? []) {
        const id = String(rec.request_id ?? rec.requestId ?? '')
        const known = (useCoworkRun.getState().pendingAsks[this.sid] ?? []).some(
          (a) => a.requestId === id
        )
        if (!id || known) continue
        this.raiseAsk(id, (rec.request ?? rec) as { questions: unknown[] })
      }
      this.flush()
    } catch {
      // Unreachable now: the turn's end still commits the transcript.
    }
  }

  /** The stream restarted from nothing: drop the preview and rebuild it. */
  private async resetAndResync(): Promise<void> {
    if (this.ended) return
    this.turns = this.reattached ? [] : this.turns.slice(0, 1)
    this.dirty = true
    this.flush()
    await this.resync()
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
    if (this.ended || this.steering) return
    this.steering = true
    try {
      const taken = useMessageQueue.getState().takeSteering(this.sid)
      for (const message of taken) {
        const turn: CoworkTurn = { role: 'user', content: message.text, steered: true }
        this.turns = [...this.turns, turn]
        this.dirty = true
        try {
          await steerRun(this.sid, message.text, this.deps.fetchImpl)
        } catch (e) {
          // Not delivered: take it back and keep it for the user to resend.
          this.turns = this.turns.filter((t) => t !== turn)
          const queue = useMessageQueue.getState()
          queue.enqueue(this.sid, message)
          queue.hold(this.sid, message.id)
          toast.error(e instanceof Error ? e.message : String(e))
        }
      }
      this.flush()
    } finally {
      this.steering = false
    }
  }

  // ---- events ------------------------------------------------------------

  private handle(env: LiveEnvelope): void {
    const effect = mapRemoteEvent(env, { turns: this.turns, reattached: this.reattached })
    switch (effect.kind) {
      case 'turns':
        this.turns = effect.turns
        this.dirty = true
        return
      case 'usage':
        this.usage = effect.usage
        useCoworkRun.getState().setUsage(this.sid, effect.usage)
        return
      case 'error':
        this.errorText = effect.text
        return
      case 'permission':
        this.raisePermission(effect.raw)
        return
      case 'ask':
        this.raiseAsk(effect.requestId, effect.request)
        return
      case 'ask-resolved':
        this.askResolved(effect.requestId, effect.state)
        return
      case 'subagent':
        this.feed.apply(effect.event)
        return
      case 'approval-resolved':
        this.resolvedElsewhere(effect.requestId)
        return
      case 'finish':
        void this.finish(effect.payload)
        useRemoteWorktrees.getState().bump(this.sid)
        return
      case 'proposal-created':
        useRemoteWorktrees.getState().proposalCreated(this.sid, effect.payload)
        return
      case 'proposal-error':
        useRemoteWorktrees.getState().proposalFailed(this.sid, effect.message)
        return
      case 'worktree-changed':
        useRemoteWorktrees.getState().bump(this.sid)
        return
      case 'none':
        return
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
    const spend =
      tool === 'spend_pause' ? describeSpendPause(command) : undefined
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
        ...(diff
          ? { preview: diff }
          : (spend ?? command)
            ? { preview: (spend ?? command)! }
            : {}),
        taskContext: where
          ? i18n.t('permissions:remote.runsOnServerAt', { where })
          : i18n.t('permissions:remote.runsOnServer'),
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
          // A typed refusal reason goes to the server, which tells the run.
          const reason =
            answer === 'deny'
              ? useToolApprovalRequests.getState().takeRefusalReason(serverId)
              : undefined
          void approveRun(this.sid, serverId, answer, this.deps.fetchImpl, undefined, reason).catch((e) =>
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
    this.resolveSettled()
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
  deps: RemoteDeps = {},
  attachments?: RunAttachment[]
): Promise<void> {
  // A local session never reaches the server runner.
  if (!isRemoteSession(sid)) throw new Error('That session is not a server session.')
  if (!isServerTransport() && !deps.fetchImpl) {
    throw new Error('Server sessions can only be run from a page the server serves.')
  }
  const busy = () => live.has(sid) || !!useCoworkRun.getState().runs[sid]
  if (busy()) {
    // A turn that is just ending may still be committing its transcript.
    const ending = live.get(sid)
    if (ending) {
      await Promise.race([ending.settled, new Promise<void>((r) => setTimeout(r, 3000))])
    }
    if (busy()) throw new Error('A turn is still running; wait for it to finish')
  }
  const base: CoworkTurn[] = [{ role: 'user', content: text }]
  const run = new RemoteRun(sid, crypto.randomUUID(), base, deps)
  run.begin()
  try {
    await syncRemoteMode(sid, deps.fetchImpl)
    const started = await startRun(sid, text, deps.fetchImpl, attachments)
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
