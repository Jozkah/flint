// One server turn, mirrored into the run store: the stream's events become
// turns, question cards and permission prompts, and the turn's end commits
// the transcript. Used by remoteCowork.ts.

import { toast } from 'sonner'
import { attachAskToTurns, settleAskInTurns, useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  useToolApprovalRequests,
  type ApprovalDecision,
  type PendingApproval,
} from '@/hooks/useToolApprovalRequests'
import { useMessageQueue } from '@/stores/message-queue-store'
import { beginRun, endRun, getRunHandle } from '@/lib/coworkRunner'
import { RustSubagentFeed } from '@/lib/rustSubagentFeed'
import { useRemoteWorktrees } from '@/lib/remoteWorktree'
import { mapRemoteEvent } from '@/lib/remoteEventMapper'
import { describeSpendPause } from '@/lib/spendPause'
import { i18n } from '@/i18n/react-i18next-compat'
import {
  answerRunAsk,
  approveRun,
  getRemoteSession,
  interruptRun,
  steerRun,
  subscribeRun,
  type LiveEnvelope,
} from '@/lib/remoteRunner'
import type { AskAnswer, CoworkTurn, Usage } from '@/types/coworkSession'
import {
  type RemoteDeps,
  endingFor,
  commitTurns,
  loadRemoteTranscript,
  live,
} from '@/lib/remoteCoworkShared'

export class RemoteRun {
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
