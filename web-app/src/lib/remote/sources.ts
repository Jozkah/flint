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
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
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
import type { RemoteMessage } from './protocol'

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
