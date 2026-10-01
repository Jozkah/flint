// The app's stores and services, as the remote handlers read them. Kept apart
// from the handlers so those stay testable with plain data.

import type { ThreadMessage } from '@janhq/core'
import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useRoomsStore } from '@/lib/rooms/store'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { getProviderTitle, isLocalProvider } from '@/lib/utils'
import { useHardware } from '@/hooks/useHardware'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useWebSearchConfig, WEB_SEARCH_PROVIDERS } from '@/hooks/useWebSearchConfig'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
import { replyMetaOf } from './replyMeta'
import { useProxyConfig } from '@/hooks/useProxyConfig'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useTheme } from '@/hooks/useTheme'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { buildBootAppearance } from '@/lib/bootAppearance'
import { i18n } from '@/i18n/react-i18next-compat'
import { uiMessageText, type RemoteSources } from './handlers'
import { approvalOf, coworkDetailOf, roomDetailOf, toolStepsOf } from './details'
import { remoteApi } from './api'
import { useMessageQueue } from '@/stores/message-queue-store'
import { sessionPrStatuses, usePrStatusStore } from '@/stores/pr-status-store'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import { formatChangeSummary } from '@/lib/coworkChangeSummary'
import { artifactsFromTurns } from '@/lib/coworkArtifacts'
import { readNotificationPrefs } from './appActions'
import { coworkReplyOf, roomReplyOf } from './events'
import { streamSnapshot } from './streams'
import { coworkToolStep, type LiveReply } from './live'
import type {
  CoworkActivity,
  CoworkChanges,
  RemoteMessage,
  SessionKind,
  StreamSnapshot,
} from './protocol'

const MAX_HUNKS = 6
const MAX_HUNK_CHARS = 4000

const snapshotOf = (kind: SessionKind, id: string, r: LiveReply | null): StreamSnapshot | null =>
  r
    ? {
        kind,
        id,
        messageId: r.messageId,
        text: r.text,
        reasoning: r.reasoning,
        tools: r.tools,
        ...(r.author ? { author: r.author } : {}),
      }
    : null

/** A session's committed turns, and the live lane while it runs. */
export function coworkTurnsOf(id: string) {
  const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
  if (!session) return null
  const run = useCoworkRun.getState()
  const live = run.runs[id] ? (run.liveTurns[id] ?? []) : []
  return {
    session,
    turns: [...(session.turns ?? []), ...live],
    subagents: run.subagents[id] ?? [],
    running: Boolean(run.runs[id]),
  }
}

function threadMessageText(m: ThreadMessage): string {
  return (m.content ?? [])
    .map((c) => c.text?.value ?? '')
    .filter(Boolean)
    .join('\n')
}

const ms = (t: number) => (t < 1e12 ? Math.round(t * 1000) : t)

export const appSources: RemoteSources = {
  chats: () =>
    Object.values(useThreads.getState().threads).map((t) => {
      const project = t.metadata?.project as { name?: string } | undefined
      return {
        id: t.id,
        title: t.title,
        updated: t.updated,
        project: project?.name,
        pinned: Boolean(t.isFavorite),
      }
    }),

  coworkSessions: () =>
    useCoworkSessions.getState().sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updated: s.updated,
      folder: s.folder,
    })),

  rooms: async () => {
    const cached = useRoomsStore.getState().summaries
    const summaries = cached.length ? cached : await getRoomPersistence().listRooms()
    return summaries.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: r.updatedAt,
    }))
  },

  running: () => ({
    chat: new Set(
      Object.entries(useAppState.getState().busyThreads)
        .filter(([, busy]) => busy)
        .map(([id]) => id)
    ),
    cowork: new Set(Object.keys(useCoworkRun.getState().runs)),
    room: new Set(useRoomsStore.getState().runningRoomIds),
  }),

  approvals: () =>
    allApprovalRequests(useToolApprovalRequests.getState()).map((a) => ({
      requestId: a.requestId,
      threadId: a.threadId,
    })),

  chatMessages: async (id) => {
    if (!useThreads.getState().threads[id]) return []
    const messages = await getServiceHub().messages().fetchMessages(id)
    return messages.map(
      (m): RemoteMessage => ({
        id: m.id,
        role: m.role as RemoteMessage['role'],
        text: threadMessageText(m),
        createdAt: ms(m.created_at),
        ...(m.role === 'assistant' ? replyMetaOf(m) : {}),
      })
    )
  },

  coworkMessages: (id) => {
    const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
    if (!session) return null
    const awaiting = new Set(
      allApprovalRequests(useToolApprovalRequests.getState())
        .filter((a) => a.threadId === id)
        .map((a) => a.toolCallId)
    )
    return session.messages.map((m): RemoteMessage => {
      const tools = m.role === 'assistant' ? toolStepsOf(m, awaiting) : []
      return {
        id: m.id,
        role: m.role as RemoteMessage['role'],
        text: uiMessageText(m),
        createdAt: session.updated,
        ...(tools.length ? { tools } : {}),
      }
    })
  },

  roomMessages: async (id) => {
    const { room, journal } = await getRoomPersistence().getRoom(id)
    return journal.flatMap((r): RemoteMessage[] =>
      r.type === 'message'
        ? [
            {
              id: r.message.id,
              role: r.message.author.kind === 'user' ? 'user' : 'assistant',
              text: r.message.text,
              createdAt: r.message.createdAt,
              author:
                'name' in r.message.author ? r.message.author.name : undefined,
              ...('participantId' in r.message.author
                ? speakerOf(room, r.message.author.participantId)
                : {}),
            },
          ]
        : []
    )
  },

  providers: () =>
    useModelProvider
      .getState()
      .providers.filter((p) => p.active)
      .map((p) => ({
        provider: p.provider,
        title: getProviderTitle(p.provider),
        local: Boolean(isLocalProvider(p.provider)),
        models: p.models
          .filter((m) => !m.embedding)
          .map((m) => ({ id: m.id, name: m.displayName ?? m.name })),
      })),

  loadedModels: async () => {
    try {
      return (await getServiceHub().models().getActiveModels()) ?? []
    } catch {
      return useAppState.getState().activeModels
    }
  },

  favoriteModels: () => useFavoriteModel.getState().favoriteModels.map((m) => m.id),

  roomDetail: async (id) => {
    try {
      const { room } = await getRoomPersistence().getRoom(id)
      return roomDetailOf(room)
    } catch {
      return null
    }
  },

  coworkDetail: (id) => {
    const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
    return session ? coworkDetailOf(session) : null
  },

  approvalDetails: () =>
    allApprovalRequests(useToolApprovalRequests.getState())
      .filter((a) => !a.origin)
      .map((a) => approvalOf(a, (key, values) => i18n.t(key, values))),

  systemInfo: async () => {
    const { hardwareData: hw, systemUsage: use } = useHardware.getState()
    const api = useLocalApiServer.getState()
    const status = await remoteApi.getStatus().catch(() => null)
    return {
      computerName: status?.serving?.host ?? null,
      os: hw.os?.name ?? hw.os_name ?? '',
      cpu: {
        name: hw.cpu.name,
        cores: hw.cpu.core_count,
        arch: hw.cpu.arch,
        extensions: hw.cpu.extensions,
        usage: use.cpu,
      },
      ram: { total: use.total_memory || hw.total_memory, used: use.used_memory },
      gpus: hw.gpus.map((g) => ({
        name: g.name,
        vram: g.total_memory,
        used: use.gpus.find((u) => u.uuid === g.uuid)?.used_memory ?? null,
        ...(g.driver_version ? { driver: g.driver_version } : {}),
      })),
      localApi: {
        running: useAppState.getState().serverStatus === 'running',
        host: api.serverHost,
        port: api.serverPort,
        prefix: api.apiPrefix,
      },
    }
  },

  mcpServers: () =>
    Object.entries(useMCPServers.getState().mcpServers).map(([name, cfg]) => ({
      name,
      active: cfg.active !== false,
      transport: cfg.type ?? 'stdio',
      ...(cfg.description ? { description: cfg.description } : {}),
    })),

  settings: async () => {
    const general = useGeneralSetting.getState()
    const api = useLocalApiServer.getState()
    const web = useWebSearchConfig.getState()
    const proxy = useProxyConfig.getState()
    const jev = useJevSettings.getState()
    const servers = Object.values(useMCPServers.getState().mcpServers)
    const providers = useModelProvider.getState().providers
    const status = await remoteApi.getStatus().catch(() => null)
    const theme = useTheme.getState().activeTheme
    return {
      version: VERSION,
      theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
      spellCheck: general.spellCheckChatInput,
      language: general.currentLanguage ?? null,
      localApi: {
        enabled: useAppState.getState().serverStatus === 'running',
        host: api.serverHost,
        port: api.serverPort,
        prefix: api.apiPrefix,
        cors: api.corsEnabled,
        hasKey: Boolean(api.apiKey),
      },
      webSearch: { enabled: web.webSearchEnabled, provider: web.searchProvider || null },
      proxy: {
        enabled: proxy.proxyEnabled,
        url: proxy.proxyUrl,
        verifySsl: !proxy.proxyIgnoreSSL,
        noProxy: proxy.noProxy,
      },
      jev: { skills: jev.skillMode, rerank: jev.rerankMode },
      automation: {
        routeAssistants: useAutomationSettings.getState().routeAssistants,
        activateSkills: useAutomationSettings.getState().activateSkills,
      },
      webSearchProviders: WEB_SEARCH_PROVIDERS.map((p) => ({
        id: p.id,
        name: p.label,
        needsKey: !p.noSetup && !p.keyless,
        configured: Boolean(
          p.noSetup || web.apiKeys[p.id] || (p.requiresEndpoint && web.endpoints[p.id])
        ),
      })),
      agentTools: useAgentToolsConfig.getState().agentToolsEnabled,
      mcpServers: {
        total: servers.length,
        active: servers.filter((c) => c.active !== false).length,
      },
      providers: {
        total: providers.length,
        active: providers.filter((p) => p.active).length,
      },
      remote: status
        ? {
            allowApprovals: status.config.allowApprovals,
            allowAlwaysAllow: status.config.allowAlwaysAllow,
            interface: status.config.interface,
          }
        : null,
    }
  },

  streamSnapshot: (kind, id) =>
    kind === 'cowork'
      ? snapshotOf(kind, id, coworkReplyOf(id))
      : kind === 'room'
        ? snapshotOf(kind, id, roomReplyOf(id))
        : streamSnapshot(kind, id),

  queue: (id) =>
    useMessageQueue
      .getState()
      .getQueue(id)
      .map((m) => ({
        id: m.id,
        text: m.text,
        steer: Boolean(m.steer),
        held: Boolean(m.held),
        ...(m.from ? { from: m.from.displayName } : {}),
      })),

  coworkChanges: (id): CoworkChanges | null => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const { session, turns, subagents, running } = found
    const diffs = collectCodeFileDiffs(turns, subagents)
    const counts = {
      fileCount: diffs.length,
      additions: diffs.reduce((n, d) => n + d.additions, 0),
      deletions: diffs.reduce((n, d) => n + d.deletions, 0),
    }
    const tree = useCoworkWorktrees.getState().bySession[id]
    const prs = usePrStatusStore.getState()
    const pr = sessionPrStatuses(prs.sessionPrs[id] ?? [], prs.byUrl)[0]
    return {
      files: diffs.map((d) => ({
        path: d.path,
        additions: d.additions,
        deletions: d.deletions,
        source: [...new Set(d.operations.map((o) => o.sourceName ?? o.source))].join(', '),
        hunks: d.operations.slice(-MAX_HUNKS).map((o) => o.diff.slice(0, MAX_HUNK_CHARS)),
      })),
      // As the desktop's What changed row: only once a run has finished.
      summary: !running && diffs.length ? formatChangeSummary(counts) : null,
      worktree: tree ? { branch: tree.kind === 'copy' ? null : tree.branch, path: tree.path } : null,
      pr: pr
        ? {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            state: pr.state,
            checks: pr.checks,
            conflicts: pr.merge === 'conflicting',
          }
        : null,
      applyOnDesktop: diffs.length > 0 && (session.access ?? 'review-only') === 'review-only',
    }
  },

  coworkActivity: (id): CoworkActivity | null => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const commands = found.turns.flatMap((t) => {
      if (t.role !== 'tool' || (t.name !== 'bash' && t.name !== 'shell')) return []
      const step = coworkToolStep(t, new Set())
      return step ? [{ id: step.id, command: step.arg ?? step.name, status: step.status }] : []
    })
    return {
      subagents: found.subagents.map((r) => ({
        id: r.runId,
        name: r.name,
        status: r.status,
        startedAt: r.startedAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        steps: r.turns.filter((t) => t.role === 'tool').length,
      })),
      commands: commands.slice(-50),
    }
  },

  library: () =>
    useCoworkSessions.getState().sessions.flatMap((session) =>
      artifactsFromTurns(session.turns, session.folder).map((a) => ({
        path: a.path,
        title: a.title,
        group: a.group,
        label: a.label,
        sessionId: session.id,
        sessionTitle: session.title,
        updatedAt: ms(session.updated),
      }))
    ),

  permissions: async () => {
    const status = await remoteApi.getStatus().catch(() => null)
    return status
      ? { approvals: status.config.allowApprovals, alwaysAllow: status.config.allowAlwaysAllow }
      : null
  },

  notificationPrefs: (device) => readNotificationPrefs(device),

  appearance: () => {
    const ui = useInterfaceSettings.getState()
    const { vars } = buildBootAppearance({
      theme: useTheme.getState().activeTheme,
      isDark: useTheme.getState().isDark,
      accent: ui.accent,
      fontSize: '',
      reduceMotion: false,
    })
    return { vars }
  },
}

/** A room speaker's role and model, for the phone's message header. */
function speakerOf(
  room: { participants: { id: string; role: string; model: { id: string } }[] },
  participantId: string
): { authorRole?: string; authorModel?: string } {
  const p = room.participants.find((x) => x.id === participantId)
  return p ? { authorRole: p.role, authorModel: p.model.id } : {}
}
