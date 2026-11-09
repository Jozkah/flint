// `RemoteSources` for the rest of the computer: what waits on the user, models,
// and the system, tools, settings, library, permissions and appearance.

import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { allApprovalRequests, useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { getServiceHub } from '@/hooks/useServiceHub'
import { getProviderTitle, isLocalProvider } from '@/lib/utils'
import { useHardware } from '@/hooks/useHardware'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useWebSearchConfig, WEB_SEARCH_PROVIDERS } from '@/hooks/useWebSearchConfig'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
import { useProxyConfig } from '@/hooks/useProxyConfig'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useTheme } from '@/hooks/useTheme'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { buildBootAppearance } from '@/lib/bootAppearance'
import { i18n } from '@/i18n/react-i18next-compat'
import type { RemoteSources } from './handlers'
import { approvalOf } from './details'
import { appAsks } from './appAsks'
import { appPrompts } from './appPrompts'
import { remoteApi } from './api'
import { artifactsFromTurns } from '@/lib/coworkArtifacts'
import { readNotificationPrefs } from './notificationPrefs'
import { appStudio } from './appStudio'
import { mergeStudioLibrary } from './studio'
import { ms } from './sessionViews'

/** Waiting on the user: approvals, asks and prompts. */
export const attentionSources: Pick<RemoteSources, 'approvals' | 'approvalDetails' | 'asks' | 'prompts'> = {
  approvals: () =>
    allApprovalRequests(useToolApprovalRequests.getState()).map((a) => ({
      requestId: a.requestId,
      threadId: a.threadId,
    })),
  approvalDetails: () =>
    allApprovalRequests(useToolApprovalRequests.getState()).map((a) =>
      approvalOf(a, (key, values) => i18n.t(key, values))
    ),
  asks: () => appAsks(),
  prompts: () => appPrompts(),
}

/** Models and providers. */
export const modelSources: Pick<RemoteSources, 'providers' | 'loadedModels' | 'favoriteModels'> = {
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
}

/** The computer: system, tools, settings, library, permissions and appearance. */
export const appSourcesMisc: Pick<RemoteSources, 'systemInfo' | 'mcpServers' | 'settings' | 'library' | 'permissions' | 'notificationPrefs' | 'appearance'> = {
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
  library: async () => {
    const cowork = useCoworkSessions.getState().sessions.flatMap((session) =>
      artifactsFromTurns(session.turns, session.folder).map((a) => ({
        path: a.path,
        title: a.title,
        group: a.group,
        label: a.label,
        sessionId: session.id,
        sessionTitle: session.title,
        updatedAt: ms(session.updated),
      }))
    )
    // Studio results join the list when the gallery can be read (Windows).
    const studio = await Promise.all([appStudio.gallery('image'), appStudio.gallery('video')])
      .then(([a, b]) => [...a, ...b])
      .catch(() => [])
    return mergeStudioLibrary(cowork, studio)
  },
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
