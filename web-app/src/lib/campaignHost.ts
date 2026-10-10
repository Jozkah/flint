/**
 * Wires the campaign runner to the app's stores (docs/CAMPAIGNS.md).
 *
 * `createRunnerHost` is the only place that touches Cowork sessions, the split
 * panes, worktrees, grants and the mailbox on a campaign's behalf, so
 * `campaignRunner` and `campaignTools` stay testable with fakes.
 */
import { invoke } from '@tauri-apps/api/core'
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
import { getServiceHub } from '@/hooks/useServiceHub'
import { sessionMailbox } from '@/lib/sessionMailbox'
import { pushNotice } from '@/lib/coworkRunNotices'
import { abortRun } from '@/lib/coworkRunner'
import { executeAgentTool } from '@/lib/agentTools'
import { campaignApi } from '@/lib/campaignApi'
import {
  createCampaignRunner,
  type CampaignRunner,
  type RunnerHost,
} from '@/lib/campaignRunner'
import type { CampaignToolDeps } from '@/lib/campaignTools'
import { errorText } from '@/lib/errorText'

const dataFolder = async (): Promise<string> =>
  (await getServiceHub().app().getJanDataFolder()) ?? ''

export function createRunnerHost(): RunnerHost {
  return {
    maxParallel: () => useCampaignSettings.getState().maxParallel,
    liveSessions: () => new Set(Object.keys(useCoworkRun.getState().runs)),
    freePanes: () => {
      const { panes, maxPanes } = useSplitConversation.getState()
      // The main pane is not one of `panes`; an empty pane can take a session.
      const empty = panes.filter((p) => !p.refId).length
      return Math.max(0, maxPanes - 1 - panes.length + empty)
    },
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
    openPane: (sid) =>
      useSplitConversation.getState().addPane({ kind: 'cowork', refId: sid }),
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
      await sessionMailbox.register({ sessionId: sid, displayName: title, folder })
    },
    enqueueSeed: (sid, text) =>
      useMessageQueue.getState().enqueue(sid, {
        id: `campaign-seed-${sid}`,
        text,
        createdAt: Date.now(),
      }),
    worktreeRecordFor: (sid) => useCoworkWorktrees.getState().bySession[sid],
    commitPending: (record, folder, message) =>
      invoke<boolean>('agent_worktree_commit_pending', {
        dataFolder: folder,
        record,
        message,
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
          .find((t) => t.role === 'assistant' && t.content.trim())?.content ?? ''
      return {
        stoppedBy: ending?.stoppedBy ?? 'done',
        errorText: ending?.errorText,
        lastReply: reply,
        tokens: session?.lastUsage?.total_tokens ?? 0,
      }
    },
    abortRun: (sid) => abortRun(sid, 'cancelled'),
    notifyCoordinator: (sid, text) => pushNotice(sid, text),
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
    track: (id) => trackCampaign(id),
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
    if (state.panes !== prev.panes || state.maxPanes !== prev.maxPanes) kickAll()
  })
  void (async () => {
    try {
      for (const c of await campaignApi.list()) {
        if (c.status === 'done' || c.status === 'failed' || c.status === 'cancelled') {
          continue
        }
        trackCampaign(c.id)
        if (c.status === 'running' || c.status === 'interrupted') {
          await r.resume(c.id).catch(() => undefined)
        }
        await r.repushNotices(c.id).catch(() => undefined)
      }
    } catch (e) {
      console.warn('[campaign] startup sweep failed:', errorText(e))
    }
  })()
  return () => {
    offRuns()
    offSettings()
    offPanes()
  }
}
