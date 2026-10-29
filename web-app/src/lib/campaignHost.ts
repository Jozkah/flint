/**
 * Wires the campaign runner to the app's stores (docs/CAMPAIGNS.md).
 *
 * `createRunnerHost` is the only place that touches Cowork sessions, the split
 * panes, worktrees, grants and the mailbox on a campaign's behalf, so
 * `campaignRunner` and `campaignTools` stay testable with fakes.
 */
import { invokeCommand as invoke } from '@/lib/backend'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { useCampaignSettings } from '@/hooks/useCampaignSettings'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ModelFactory } from '@/lib/model-factory'
import { runUtilityAgent } from '@/lib/utilityAgents'
import { getServiceHub } from '@/hooks/useServiceHub'
import { sessionMailbox } from '@/lib/sessionMailbox'
import { pushNotice } from '@/lib/coworkRunNotices'
import { abortRun } from '@/lib/coworkRunner'
import { executeAgentTool } from '@/lib/agentTools'
import { campaignApi } from '@/lib/campaignApi'
import { allowNotifications, notifyInBackground } from '@/lib/notify'
import { accountPanes } from '@/lib/campaignPanes'
import { useCampaignResumed } from '@/hooks/useCampaignResumed'
import { useCampaignNotes } from '@/lib/campaignNotes'
import {
  createCampaignRunner,
  parseModel,
  type CampaignRunner,
  type RunnerHost,
} from '@/lib/campaignRunner'
import type { CampaignToolDeps } from '@/lib/campaignTools'
import { createBoardActions } from '@/lib/campaignBoardActions'
import { errorText } from '@/lib/errorText'

const dataFolder = async (): Promise<string> =>
  (await getServiceHub().app().getJanDataFolder()) ?? ''

/** When this process opened each task's pane: a start in flight is not idle. */
const openedAt = new Map<string, number>()
const PANE_START_GRACE_MS = 30_000

function paneAccounting(busy?: ReadonlySet<string>) {
  const { panes, maxPanes } = useSplitConversation.getState()
  const sessions = useCoworkSessions.getState().sessions
  const queue = useMessageQueue.getState()
  const t = Date.now()
  const recent = new Set(
    [...openedAt]
      .filter(([, at]) => t - at < PANE_START_GRACE_MS)
      .map(([s]) => s)
  )
  return accountPanes({
    panes,
    maxPanes,
    liveSessions: new Set(Object.keys(useCoworkRun.getState().runs)),
    isTaskSession: (sid) =>
      sessions.find((s) => s.id === sid)?.campaign?.role === 'task',
    hasQueued: (sid) => queue.getQueue(sid).length > 0,
    busy: new Set([...(busy ?? []), ...recent]),
  })
}

export function createRunnerHost(): RunnerHost {
  return {
    maxParallel: () => useCampaignSettings.getState().maxParallel,
    liveSessions: () => new Set(Object.keys(useCoworkRun.getState().runs)),
    freePanes: (busy) => paneAccounting(busy).free,
    dataFolder,
    linkOf: (sid) =>
      useCoworkSessions.getState().sessions.find((s) => s.id === sid)?.campaign,
    sessionExists: (sid) =>
      useCoworkSessions.getState().sessions.some((s) => s.id === sid),
    createTaskSession: ({ title, folder, mode, model, link }) => {
      const id = crypto.randomUUID()
      // Added without selecting it: the focused session stays the user's.
      useCoworkSessions.setState((s) => ({
        sessions: [
          {
            id,
            title,
            folder: null,
            turns: [],
            messages: [],
            updated: Date.now(),
            createdAt: Date.now(),
          },
          ...s.sessions,
        ],
      }))
      const store = useCoworkSessions.getState()
      store.setFolder(id, folder)
      // After the folder, so the explicit mode wins over the folder default.
      store.setMode(id, mode)
      if (model) store.setModel(id, model)
      store.setCampaign(id, link)
      return id
    },
    deleteSession: (sid) => useCoworkSessions.getState().deleteSession(sid),
    openPane: (sid) => {
      const split = useSplitConversation.getState()
      const target = { kind: 'cowork' as const, refId: sid }
      let result = split.addPane(target)
      if (result === 'full') {
        // Recycle a pane that only shows a finished campaign task, then retry.
        const victim = paneAccounting().recyclable[0]
        if (victim) {
          useSplitConversation.getState().closePane(victim)
          result = useSplitConversation.getState().addPane(target)
        }
      }
      if (result !== 'full') openedAt.set(sid, Date.now())
      return result
    },
    ensureWorktree: (sid, project, folder, options) =>
      useCoworkWorktrees.getState().ensure(sid, project, folder, options),
    attachWorktree: async (sid, path, folder) => {
      const granted = await useDirectEditGrants
        .getState()
        .authorize(sid, path, folder, [])
      if (!granted.ok) return { ok: false, reason: granted.reason }
      useCoworkSessions.getState().setAccess(sid, 'managed-worktree')
      return { ok: true }
    },
    registerMailbox: async (sid, title, folder) => {
      await sessionMailbox.register({
        sessionId: sid,
        displayName: title,
        folder,
      })
    },
    enqueueSeed: (sid, text) =>
      useMessageQueue.getState().enqueue(sid, {
        id: `campaign-seed-${sid}`,
        text,
        createdAt: Date.now(),
      }),
    worktreeRecordFor: (sid) => useCoworkWorktrees.getState().bySession[sid],
    commitPending: (record, folder, message, declaredPaths) =>
      invoke<boolean>('agent_worktree_commit_pending', {
        dataFolder: folder,
        record,
        message,
        declared: declaredPaths ?? [],
      }),
    unmergedCommits: (record) =>
      useCoworkWorktrees.getState().unmerged(record as WorktreeRecord),
    endOf: (sid) => {
      const ending = useCoworkRun.getState().outcomes[sid]
      const session = useCoworkSessions
        .getState()
        .sessions.find((s) => s.id === sid)
      const reply =
        [...(session?.turns ?? [])]
          .reverse()
          .find((t) => t.role === 'assistant' && t.content.trim())?.content ??
        ''
      return {
        stoppedBy: ending?.stoppedBy ?? 'done',
        errorText: ending?.errorText,
        lastReply: reply,
        tokens: session?.lastUsage?.total_tokens ?? 0,
      }
    },
    abortRun: (sid) => abortRun(sid, 'cancelled'),
    notifyCoordinator: (sid, text) => pushNotice(sid, text),
    // An idle coordinator is woken by mail from the task that finished: the
    // mailbox's auto-wake path brings it into a pane and releases the message.
    wakeCoordinator: async (from, coordinator, text) => {
      const session = useCoworkSessions
        .getState()
        .sessions.find((s) => s.id === coordinator)
      if (!session) return false
      try {
        await sessionMailbox.register({
          sessionId: coordinator,
          displayName: session.title.slice(0, 120),
          folder: session.folder ?? '',
        })
      } catch {
        /* already registered, or the send below says why not */
      }
      const r = await executeAgentTool(
        'send_message',
        { to: coordinator, message: text },
        from,
        { scope: 'session' }
      )
      return !r.error
    },
    askVerifier: async (request, campaign) => {
      const system = request.messages.find((m) => m.role === 'system')
      const rest = request.messages.filter((m) => m !== system)
      const ref = parseModel(campaign.model)
      const state = useModelProvider.getState()
      const providerName = ref?.provider ?? state.selectedProvider
      const modelId = ref?.id ?? state.selectedModel?.id
      const provider = providerName
        ? state.getProviderByName(providerName)
        : undefined
      if (!provider || !modelId) {
        throw new Error('no model is selected to verify with')
      }
      const model = await ModelFactory.createModel(modelId, provider, {})
      const text = await runUtilityAgent({
        kind: 'classify',
        session: campaign.coordinatorSession,
        model,
        modelId,
        system: system?.content,
        messages: rest.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        maxOutputTokens: 3000,
        abortSignal: AbortSignal.timeout(180_000),
        maxRetries: 1,
      })
      // The utility call returns text only (its exact counts go to the audit
      // log), so the cost recorded on the task is an estimate from sizes, at
      // about four characters a token: honest in magnitude, not to the digit.
      const sent =
        (system?.content.length ?? 0) +
        rest.reduce((n, m) => n + m.content.length, 0)
      return { text, tokens: Math.ceil((sent + text.length) / 4) }
    },
    runInfo: (sid) => {
      const state = useCoworkRun.getState()
      const run = state.runs[sid]
      if (!run) return undefined
      // Steps are counted from the tool calls the run has made so far.
      const steps = (state.liveTurns[sid] ?? []).filter(
        (t) => t.role === 'tool'
      ).length
      return {
        startedAt: run.startedAt,
        steps,
        tokens: state.usage[sid]?.total_tokens ?? 0,
      }
    },
    waitingOn: (sid) => {
      const approvals = useToolApprovalRequests.getState()
      const approval = [
        ...Object.values(approvals.pending),
        ...Object.values(approvals.queued).flat(),
      ].some((p) => p.threadId === sid)
      if (approval) return 'approval'
      return (useCoworkRun.getState().pendingAsks[sid]?.length ?? 0) > 0
        ? 'input'
        : null
    },
    isShown: (sid) =>
      useCoworkSessions.getState().currentId === sid ||
      useSplitConversation
        .getState()
        .panes.some((p) => p.kind === 'cowork' && p.refId === sid),
    hasEnded: (sid) => !!useCoworkRun.getState().outcomes[sid],
    desktopNotify: (title, body) => notifyInBackground(title, body),
  }
}

export function createToolDeps(runner: CampaignRunner): CampaignToolDeps {
  return {
    api: campaignApi,
    runner,
    maxParallel: () => useCampaignSettings.getState().maxParallel,
    dataFolder,
    // The integration branch is a worktree of its own, keyed by the campaign,
    // so every task can start from it and a denied plan never made one.
    ensureIntegration: async (campaignId, sourceRoot, folder, title) => {
      const key = `campaign-${campaignId}`
      const made = await useCoworkWorktrees
        .getState()
        .ensure(key, sourceRoot, folder, { title: `campaign ${title}` })
      if (!made.ok) return made
      // Not a session's worktree: the renderer must not offer it to one.
      useCoworkWorktrees.getState().forget(key)
      return made
    },
    sendMessage: async (from, to, text) => {
      const r = await executeAgentTool(
        'send_message',
        { to, message: text },
        from,
        { scope: 'session' }
      )
      if (r.error) return { ok: false, error: r.error }
      return {
        ok: true,
        output:
          typeof r.content === 'string'
            ? r.content
            : JSON.stringify(r.content ?? ''),
      }
    },
    track: (id) => {
      // Asked once, from the approval the person just gave.
      void allowNotifications()
      trackCampaign(id)
    },
  }
}

// ---------------------------------------------------------------------------
// The singleton the app uses
// ---------------------------------------------------------------------------

let runner: CampaignRunner | null = null
const tracked = new Set<string>()

export function getCampaignRunner(): CampaignRunner {
  runner ??= createCampaignRunner(createRunnerHost())
  return runner
}

export function trackCampaign(id: string): void {
  tracked.add(id)
}

const kickAll = () => {
  for (const id of tracked) {
    void getCampaignRunner()
      .kick(id)
      .catch((e) => console.warn('[campaign] scheduling failed:', errorText(e)))
  }
}

/** Limits, waiting state and closed panes, for every tracked campaign. */
const sweepAll = () => {
  for (const id of tracked) {
    void getCampaignRunner()
      .sweep(id)
      .catch((e) => console.warn('[campaign] sweep failed:', errorText(e)))
  }
}

const SWEEP_EVERY_MS = 10_000

/**
 * Start the loop: settle tasks whose runs end, re-kick when a pane frees or
 * the setting changes, and on startup resume what a restart interrupted and
 * re-push notices the coordinator never got. Returns a stop function.
 */
export function startCampaignRunner(): () => void {
  const r = getCampaignRunner()
  const offRuns = useCoworkRun.subscribe((state, prev) => {
    if (state.runs === prev.runs) return
    for (const sid of Object.keys(prev.runs)) {
      if (!state.runs[sid]) {
        void r
          .onRunEnded(sid)
          .catch((e) => console.warn('[campaign] settle failed:', errorText(e)))
      }
    }
    kickAll()
  })
  const offSettings = useCampaignSettings.subscribe((state, prev) => {
    if (state.maxParallel !== prev.maxParallel) kickAll()
  })
  const offPanes = useSplitConversation.subscribe((state, prev) => {
    if (state.panes !== prev.panes || state.maxPanes !== prev.maxPanes)
      kickAll()
  })
  const timer = setInterval(sweepAll, SWEEP_EVERY_MS)
  void (async () => {
    try {
      for (const c of await campaignApi.list()) {
        if (
          c.status === 'done' ||
          c.status === 'failed' ||
          c.status === 'cancelled'
        ) {
          continue
        }
        // A server-driven campaign is the server's to run and resume.
        if (c.driver === 'server') continue
        trackCampaign(c.id)
        if (c.status === 'merging') {
          // Its proposal may have been applied or rejected while we were away.
          await campaignApi.refresh(c.id).catch(() => undefined)
        }
        if (c.status === 'running' || c.status === 'interrupted') {
          const out = await r.resume(c.id).catch(() => undefined)
          // Interrupted tasks restart on their own; the board says so.
          if (out?.resumed?.length) {
            useCampaignResumed.getState().record(c.id, out.resumed)
          }
        }
        await r.repushNotices(c.id).catch(() => undefined)
      }
    } catch (e) {
      console.warn('[campaign] startup sweep failed:', errorText(e))
    }
  })()
  return () => {
    clearInterval(timer)
    offRuns()
    offSettings()
    offPanes()
  }
}

/** The status board's actions, wired to the live app. */
export function createLiveBoardActions() {
  const r = getCampaignRunner()
  return createBoardActions({
    api: campaignApi,
    runner: r,
    sendMessage: createToolDeps(r).sendMessage,
    abortRun: (sid) => abortRun(sid, 'cancelled'),
    liveSessions: () => new Set(Object.keys(useCoworkRun.getState().runs)),
    noteSent: (campaignId, taskId, sessionId, messageId) =>
      useCampaignNotes
        .getState()
        .record(campaignId, taskId, sessionId, messageId),
  })
}

/** Re-read which notes the task runs have taken in (the board polls this). */
export const checkNoteDelivery = () =>
  useCampaignNotes.getState().settle((sid) => sessionMailbox.pending(sid))
