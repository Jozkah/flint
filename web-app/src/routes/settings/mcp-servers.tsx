import { createFileRoute, Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { SettingsPageHeader, SettingsWithSections } from '@/containers/SettingsPageHeader'
import { CardItem } from '@/containers/Card'
import {
  Braces,
  ChevronDown,
  ChevronUp,
  FileText,
  Pencil,
  Plus,
  Power,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import {
  useMCPServers,
  MCPServerConfig,
  MCPSettings,
  DEFAULT_MCP_SETTINGS,
} from '@/hooks/useMCPServers'
import { IdleShutdownInput } from '@/containers/IdleShutdownInput'
import { ServerToolTimeoutInput } from '@/containers/ServerToolTimeoutInput'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import AddEditMCPServer from '@/containers/dialogs/AddEditMCPServer'
import DeleteMCPServerConfirm from '@/containers/dialogs/DeleteMCPServerConfirm'
import EditJsonMCPserver from '@/containers/dialogs/EditJsonMCPserver'
import McpServerLogDialog from '@/containers/dialogs/McpServerLogDialog'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useToolApproval } from '@/hooks/useToolApproval'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { selfApprovalToolsOf } from '@/lib/selfApprovalTools'
import { Button } from '@/components/ui/button'
import { useModelProvider } from '@/hooks/useModelProvider'
import { McpRouterModelPicker } from '@/containers/McpRouterModelPicker'
import { McpDescriptionGenerator } from '@/containers/dialogs/McpDescriptionGenerator'
import { isRouterModelSelectable } from '@/lib/mcp-router-model-filter'
import { McpServerAuth } from '@/containers/McpServerAuth'
import { useMcpAuth } from '@/hooks/useMcpAuth'
import { useMcpServerLifecycle } from '@/hooks/useMcpServerLifecycle'
import { deriveConnectionState, runtimeCleared } from '@/lib/mcpConnectionState'
import { deriveMcpServerProfile } from '@/lib/mcpServerProfile'
import {
  McpServerDetails,
  McpServerStatus,
  mcpServerErrorId,
} from '@/containers/McpServerConnectionDetails'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import {
  SettingsTabStrip,
  useSettingsTab,
  type SettingsTab,
} from '@/containers/SettingsTabs'
import {
  EnginePage,
  PageHead,
} from '@/containers/engine/EngineKit'
import { McpKpiRow } from '@/containers/McpKpiRow'
import { McpServerSearch } from '@/containers/McpServerSearch'
import { McpServerContextMenu } from '@/containers/McpServerContextMenu'
import { LiveChart } from '@/containers/engine/LiveChart'
import { RowMenu } from '@/containers/engine/RowMenu'
import {
  bucketCounts,
  startOfToday,
  useEngineActivity,
} from '@/stores/engine-activity-store'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'

type ToolsTab = 'servers' | 'routing'
type ServersView = 'cards' | 'list'
const SERVERS_VIEW_KEY = 'flint-mcp-servers-view'

/** One bucket a minute over the last 20 minutes, like the design's charts. */
const CHART_BUCKETS = 20

const SERVER_COLORS = [
  '#3b82f6',
  '#6e40c9',
  '#2ead33',
  '#0891b2',
  '#f59e0b',
  '#64748b',
  '#ec4899',
  '#10b981',
]

/**
 * A colour per server by its place in the configuration, so the servers on
 * screen never share one and each keeps its colour until the list is edited.
 */
function serverColor(position: number): string {
  return SERVER_COLORS[Math.max(0, position) % SERVER_COLORS.length]
}


// Function to mask sensitive URL parameters
const maskSensitiveUrl = (url: string) => {
  if (!url) return url

  try {
    const urlObj = new URL(url)
    const params = urlObj.searchParams

    // List of sensitive parameter names (case-insensitive)
    const sensitiveParams = [
      'api_key',
      'apikey',
      'key',
      'token',
      'secret',
      'password',
      'pwd',
      'auth',
      'authorization',
      'bearer',
      'access_token',
      'refresh_token',
      'client_secret',
      'private_key',
      'signature',
      'hash',
    ]

    // Mask sensitive parameters
    sensitiveParams.forEach((paramName) => {
      // Check both exact match and case-insensitive match
      for (const [key] of params.entries()) {
        if (key.toLowerCase() === paramName.toLowerCase()) {
          params.set(key, '******')
        }
      }
    })

    // Credentials embedded as user:pass@host are secrets too.
    if (urlObj.username) urlObj.username = '******'
    if (urlObj.password) urlObj.password = '******'

    // Reconstruct URL with masked parameters
    urlObj.search = params.toString()
    return urlObj.toString()
  } catch {
    // If URL parsing fails, just mask the entire query string after '?'
    const queryIndex = url.indexOf('?')
    if (queryIndex === -1) return url

    const baseUrl = url.substring(0, queryIndex + 1)
    return baseUrl + '******'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.mcp_servers as any)({
  component: MCPServersDesktop,
})

function MCPServersDesktop() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const {
    mcpServers,
    settings,
    addServer,
    editServer,
    renameServer,
    deleteServer,
    syncServers,
    syncServersAndRestart,
    getServerConfig,
    setSettings,
    updateSettings,
  } = useMCPServers()
  const {
    allowAllMCPPermissions,
    isServerApproved,
    approveServerTrust,
    revokeServerTrust,
    forgetServer,
    approvedServers,
    invalidatedServers,
  } = useToolApproval()

  const [open, setOpen] = useState(false)
  /** Describe dialog: `null` closed, `''` batch, a name for one server. */
  const [describeTarget, setDescribeTarget] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [currentConfig, setCurrentConfig] = useState<
    MCPServerConfig | undefined
  >(undefined)

  // Per-server log dialog state (AH-140)
  const [logServer, setLogServer] = useState<string | null>(null)

  // Right-click context menu state
  const [ctxMenu, setCtxMenu] = useState<{
    key: string
    x: number
    y: number
  } | null>(null)

  // Search query to filter the server list by name.
  const [searchQuery, setSearchQuery] = useState('')
  // A search result for a runtime setting opens the Tool runtime tab.
  const tabs: SettingsTab<ToolsTab>[] = [
    { id: 'servers', label: t('engine:mcp.tabServers') },
    {
      id: 'routing',
      label: t('engine:mcp.tabToolRuntime', { defaultValue: 'Tool runtime' }),
      anchors: [
        'settings-mcp-servers-tool-call-timeout',
        'settings-mcp-servers-idle-shutdown',
        'settings-mcp-servers-max-tool-output',
        'settings-mcp-servers-smart-tool-routing',
        'settings-mcp-servers-lightweight-router',
        'settings-mcp-servers-generate-descriptions',
        'settings-mcp-servers-router-model',
      ],
    },
  ]
  const [tab, setTab] = useSettingsTab(tabs)
  // Each server card's Auto-approve covers that server only; the switch for
  // every MCP tool is on the Permissions page.
  const autoApproveHint = t('mcp-servers:autoApproveServerHint', { defaultValue: "Auto-approves this server's tools only. The switch for every MCP tool is under Settings > Permissions." })
  const [statusFilter, setStatusFilter] = useState<'all' | 'on' | 'off'>('all')
  const [view, setViewState] = useState<ServersView | null>(() => {
    try {
      const v = localStorage.getItem(SERVERS_VIEW_KEY)
      return v === 'cards' || v === 'list' ? v : null
    } catch {
      return null
    }
  })
  const setView = (v: ServersView) => {
    setViewState(v)
    try {
      localStorage.setItem(SERVERS_VIEW_KEY, v)
    } catch {
      /* the choice just does not persist */
    }
  }
  const toolCalls = useEngineActivity((s) => s.toolCalls)
  // Servers the user has expanded; collapsed (compact) is the default so the
  // page stays scannable with many servers installed.
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())
  const toggleExpanded = (serverKey: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev)
      if (next.has(serverKey)) {
        next.delete(serverKey)
      } else {
        next.add(serverKey)
      }
      return next
    })
  }

  // Delete confirmation dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [serverToDelete, setServerToDelete] = useState<string | null>(null)

  // JSON editor dialog state
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false)
  const [jsonServerName, setJsonServerName] = useState<string | null>(null)
  const [jsonEditorData, setJsonEditorData] = useState<
    | MCPServerConfig
    | Record<string, MCPServerConfig>
    | {
        mcpServers: Record<string, MCPServerConfig>
        mcpSettings?: MCPSettings
      }
    | undefined
  >(undefined)
  const {
    statuses: authStatuses,
    authorizing,
    consentUrls,
    refresh: refreshAuth,
    authorize,
    clearAuth,
  } = useMcpAuth(Object.keys(mcpServers))

  const setErrorMessage = useAppState((state) => state.setErrorMessage)

  const {
    connectedServers,
    loadingServers,
    lifecycle,
    runtime,
    setRuntime,
    fingerprints,
    refreshFingerprints,
    toggleServer,
    handleAuthorize,
    handleClearAuth,
    startNow,
    stopNow,
    setStartWithFlint,
    setServerToolTimeout,
  } = useMcpServerLifecycle({
    mcpServers,
    editServer,
    syncServers,
    getServerConfig,
    authorize,
    clearAuth,
    refreshAuth,
    setErrorMessage,
  })

  /**
   * A server name is going away (deleted or renamed): its approvals and stored
   * sign-in go with it, so nothing is inherited by a server added under that
   * name later. The renderer part always happens; a backend failure is shown.
   */
  const forgetServerGrants = (
    name: string,
    reason: 'deleted' | 'renamed',
    newName?: string
  ) => {
    void Promise.resolve()
      .then(() => forgetServer(name, reason))
      .then(() => {
        if (reason === 'renamed') {
          toast(
            t('mcp-servers:renameServer.approvalsReset', {
              oldName: name,
              newName,
            }),
            { description: t('mcp-servers:renameServer.approvalsResetDesc') }
          )
        }
      })
      .catch((error) => {
        toast.error(
          reason === 'renamed'
            ? t('mcp-servers:renameServer.forgetFailed', { oldName: name })
            : t('mcp-servers:deleteServer.forgetFailed', { serverName: name }),
          { description: errorText(error) }
        )
      })
  }

  const handleAutoApprove = async (serverKey: string, checked: boolean) => {
    try {
      if (checked) {
        // Read fresh rather than from the cached map: a definition saved a
        // moment ago must be the one approved, not the one before it.
        const fingerprint = (await refreshFingerprints())[serverKey]
        if (!fingerprint) {
          throw new Error(`'${serverKey}' is not saved yet`)
        }
        await approveServerTrust(serverKey, fingerprint)
      } else {
        await revokeServerTrust(serverKey)
      }
    } catch (error) {
      toast.error(
        t('mcp-servers:approval.autoApproveFailed', { serverName: serverKey }),
        { description: errorText(error) }
      )
    }
  }
  /**
   * Tool names per connected server: `undefined` while loading, `null` when
   * the list could not be read.
   */
  const [serverTools, setServerTools] = useState<
    Record<string, string[] | null>
  >({})
  const serviceHubRef = useRef(serviceHub)
  serviceHubRef.current = serviceHub
  // Server names may contain spaces ("Flint Browser MCP"), so join on NUL.
  // Enabled servers are listed too: a stopped one (servers start on demand)
  // reports its last known tools without being started.
  const connectedKey = Array.from(
    new Set([
      ...connectedServers,
      ...Object.entries(mcpServers)
        .filter(([, cfg]) => cfg.active)
        .map(([name]) => name),
    ])
  ).join('\u0000')

  useEffect(() => {
    let cancelled = false
    const names = connectedKey ? connectedKey.split('\u0000') : []
    void Promise.all(
      names.map(async (name) => {
        try {
          const tools = await serviceHubRef.current
            .mcp()
            .getToolsForServers([name])
          return [
            name,
            tools
              .filter((tool) => !tool.server || tool.server === name)
              .map((tool) => tool.name),
          ] as const
        } catch (error) {
          console.debug(`Could not list tools for MCP server ${name}:`, error)
          return [name, null] as const
        }
      })
    ).then((entries) => {
      if (!cancelled) setServerTools(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [connectedKey])

  const updateToolCallTimeout = (rawValue: string) => {
    if (rawValue === '') {
      updateSettings({
        toolCallTimeoutSeconds: DEFAULT_MCP_SETTINGS.toolCallTimeoutSeconds,
      })
      return
    }

    // Same rule as the per-server field: whole seconds, at least 1. A 0 or
    // negative entry is ignored and the field keeps the stored value.
    const numericValue = Math.floor(Number(rawValue))
    if (Number.isFinite(numericValue) && numericValue >= 1) {
      updateSettings({ toolCallTimeoutSeconds: numericValue })
    }
  }

  const updateMaxToolOutputChars = (rawValue: string) => {
    if (rawValue === '') {
      updateSettings({
        maxToolOutputChars: DEFAULT_MCP_SETTINGS.maxToolOutputChars,
      })
      return
    }

    const numericValue = Number(rawValue)
    if (!Number.isNaN(numericValue) && numericValue >= 0) {
      updateSettings({ maxToolOutputChars: numericValue })
    }
  }

  const modelProviders = useModelProvider((state) => state.providers)

  const routerPickerDisabled =
    !settings.enableSmartToolRouting || !settings.useLightweightRouterModel

  useEffect(() => {
    if (
      !settings.useLightweightRouterModel ||
      !settings.routerModelProvider ||
      !settings.routerModelId
    ) {
      return
    }
    if (modelProviders.length === 0) return

    const provider = modelProviders.find(
      (p) => p.provider === settings.routerModelProvider && p.active
    )
    const model = provider?.models.find((m) => m.id === settings.routerModelId)

    if (
      !provider ||
      !model ||
      !isRouterModelSelectable(provider, model)
    ) {
      updateSettings({ routerModelProvider: '', routerModelId: '' })
    }
  }, [
    settings.useLightweightRouterModel,
    settings.routerModelProvider,
    settings.routerModelId,
    modelProviders,
    updateSettings,
  ])

  const handleOpenDialog = (serverKey?: string) => {
    if (serverKey) {
      // Edit mode
      setCurrentConfig(mcpServers[serverKey])
      setEditingKey(serverKey)
    } else {
      // Add mode
      setCurrentConfig(undefined)
      setEditingKey(null)
    }
    setOpen(true)
  }

  const handleSaveServer = async (name: string, config: MCPServerConfig) => {
    if (editingKey) {
      // Editing restarts a running server and leaves a stopped one stopped.
      // The stop is awaited: a late deactivate cancels the fresh start.
      const wasActive = !!mcpServers[editingKey]?.active
      // If server name changed, rename it while preserving position
      if (editingKey !== name) {
        // Stopped without a save of the old name: a save still in flight
        // could land after the rename and bring the old entry back.
        if (wasActive) {
          await serviceHub
            .mcp()
            .deactivateMCPServer(editingKey)
            .catch((error) => console.error('Error deactivating server:', error))
        }
        // One backend step moves the stored entry, secrets included, to the
        // new name and drops the old one; only then is the edited (masked)
        // config saved and started under the new name, so its hidden values
        // are restored from the moved entry (BUG-081).
        try {
          await serviceHub.mcp().renameMCPServer(editingKey, name)
        } catch (error) {
          setErrorMessage({
            message: error instanceof Error ? error.message : String(error),
            subtitle: t('mcp-servers:checkParams'),
          })
          return
        }
        renameServer(editingKey, name, { ...config, active: wasActive })
        await syncServers()
        if (wasActive) await toggleServer(name, true, config)
        // Grants never follow a rename: the approval was for the old name,
        // and its OAuth tokens may belong to an endpoint the edit changed.
        forgetServerGrants(editingKey, 'renamed', name)
        // Restart servers to update tool references with new server name
        syncServersAndRestart()
      } else {
        await toggleServer(editingKey, false)
        editServer(editingKey, { ...config, active: wasActive })
        if (wasActive) await toggleServer(editingKey, true, config)
        syncServers()
      }
    } else {
      // Add new server
      await toggleServer(name, false)
      addServer(name, config)
      await toggleServer(name, true, config)
      syncServers()
    }
  }

  /** Whether an approval this server had no longer matches its configuration. */
  const approvalChanged = (serverKey: string) => {
    const current = fingerprints[serverKey]
    const staleGrant =
      !!current &&
      (approvedServers ?? []).some(
        (grant) => grant.name === serverKey && grant.fingerprint !== current
      )
    const invalidated = (invalidatedServers ?? []).some(
      (entry) =>
        entry.name === serverKey && entry.reason === 'configuration-changed'
    )
    return staleGrant || invalidated
  }

  const handleEdit = (serverKey: string) => {
    handleOpenDialog(serverKey)
  }

  const handleDeleteClick = (serverKey: string) => {
    setServerToDelete(serverKey)
    setDeleteDialogOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (serverToDelete) {
      // Stop the server before deletion
      try {
        await serviceHub.mcp().deactivateMCPServer(serverToDelete)
      } catch (error) {
        console.error('Error stopping server before deletion:', error)
      }

      deleteServer(serverToDelete)
      forgetServerGrants(serverToDelete, 'deleted')
      setRuntime((prev) => ({ ...prev, [serverToDelete]: runtimeCleared() }))
      toast.success(
        t('mcp-servers:deleteServer.success', { serverName: serverToDelete })
      )
      setServerToDelete(null)
      syncServersAndRestart()
    }
  }

  const handleOpenJsonEditor = async (serverKey?: string) => {
    if (serverKey) {
      // Edit single server JSON
      setJsonServerName(serverKey)
      setJsonEditorData(mcpServers[serverKey])
    } else {
      // Edit all servers JSON
      setJsonServerName(null)
      setJsonEditorData({
        mcpServers,
        mcpSettings: settings,
      })
    }
    setJsonEditorOpen(true)
  }

  const handleSaveJson = async (
    data:
      | MCPServerConfig
      | Record<string, MCPServerConfig>
      | {
          mcpServers?: Record<string, MCPServerConfig>
          mcpSettings?: MCPSettings
        }
  ) => {
    if (jsonServerName) {
      await toggleServer(jsonServerName, false)
      // Save single server
      editServer(jsonServerName, data as MCPServerConfig)
      await toggleServer(
        jsonServerName,
        (data as MCPServerConfig).active || false
      )
    } else {
      // Save all servers
      let nextServers: Record<string, MCPServerConfig> = {}
      let nextSettings: MCPSettings | undefined

      if (data && typeof data === 'object' && !Array.isArray(data)) {
        if ('mcpServers' in data || 'mcpSettings' in data) {
          const payload = data as {
            mcpServers?: Record<string, MCPServerConfig>
            mcpSettings?: MCPSettings
          }
          nextServers = payload.mcpServers ?? {}
          nextSettings = payload.mcpSettings
        } else {
          nextServers = data as Record<string, MCPServerConfig>
        }
      }

      if (nextSettings) {
        setSettings({
          ...DEFAULT_MCP_SETTINGS,
          ...nextSettings,
        })
      }

      // Clear existing servers first, and wait for them to stop
      await Promise.all(
        Object.keys(mcpServers).map((serverKey) => {
          const stopped = toggleServer(serverKey, false)
          deleteServer(serverKey)
          return stopped
        })
      )

      // A name that is not in the edited JSON is gone, whatever else was
      // added: forget its grants. A name that stays keeps them, and any edit
      // to what it runs is caught by its fingerprint instead.
      Object.keys(mcpServers)
        .filter((serverKey) => !(serverKey in nextServers))
        .forEach((serverKey) => forgetServerGrants(serverKey, 'deleted'))

      // Add all servers from the JSON
      Object.entries(nextServers).forEach(([key, config]) => {
        addServer(key, config)
        toggleServer(key, config.active || false)
      })

      await syncServers()
    }
  }


  const serverEntries = Object.entries(mcpServers)
  // One snapshot per server, computed once per change to its inputs rather
  // than again for every card, filter and count that asks for it.
  const snapshots = useMemo(() => {
    const compute = (key: string, config: MCPServerConfig) => {
      const authStatus = authStatuses[key]
      const profile = deriveMcpServerProfile(config, authStatus)
      return {
        authStatus,
        profile,
        snapshot: deriveConnectionState({
          installed: true,
          enabled: !!config.active,
          connected: connectedServers.includes(key),
          lifecycle: lifecycle[key],
          runtime: runtime[key],
          authStatus,
          transport: profile.transport,
        }),
      }
    }
    return { compute, byKey: new Map(Object.entries(mcpServers).map(([key, config]) => [key, { config, value: compute(key, config) }])) }
  }, [mcpServers, connectedServers, lifecycle, runtime, authStatuses])
  const snapshotFor = (key: string, config: MCPServerConfig) => {
    const hit = snapshots.byKey.get(key)
    return hit && hit.config === config ? hit.value : snapshots.compute(key, config)
  }
  const states = serverEntries.map(([key, config]) => snapshotFor(key, config).snapshot.state)
  const connectedCount = states.filter((s) => s === 'connected').length
  const connectingCount = states.filter((s) => s === 'connecting').length
  const toolCount = Object.values(serverTools).reduce(
    (n, list) => n + (list?.length ?? 0),
    0
  )
  const todayStart = startOfToday()
  const callsToday = toolCalls.filter((c) => c.at >= todayStart)
  const failedToday = callsToday.filter((c) => !c.ok).length
  const approvedCount = serverEntries.filter(([key]) =>
    isServerApproved(key, fingerprints[key])
  ).length
  const query = searchQuery.trim().toLowerCase()
  const filtered = serverEntries.filter(([key, config]) => {
    if (!key.toLowerCase().includes(query)) return false
    if (statusFilter === 'all') return true
    const on = snapshotFor(key, config).snapshot.switchOn
    return statusFilter === 'on' ? on : !on
  })
  // With many servers the tall cards bury the page: default to the dense list
  // until the user has picked a view themselves.
  const effectiveView: ServersView =
    view ?? (serverEntries.length > 6 ? 'list' : 'cards')

  const settingsRows = (
    <>
      {/* Allowing every MCP tool is a permission: its one switch is on the
          Permissions page, so this only points there. */}
      <CardItem
        wrapDescription
        title={t('permissions:settings.allowAllGroup')}
        description={t('mcp-servers:allowAllMoved', { defaultValue: 'The switch that lets every MCP tool run without asking is under Settings > Permissions.' })}
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to={route.settings.permissions}>
              {t('permissions:settings.title')}
            </Link>
          </Button>
        }
      />
      <CardItem
        // Several of these descriptions carry warnings: shown in full.
        wrapDescription
        anchor="settings-mcp-servers-tool-call-timeout"
        title={t('mcp-servers:runtimeSettings.toolCallTimeout')}
        description={t('mcp-servers:runtimeSettings.toolCallTimeoutDesc')}
        actions={
          <Input
            type="number"
            min={1}
            step={1}
            value={settings.toolCallTimeoutSeconds}
            onChange={(event) => updateToolCallTimeout(event.target.value)}
            onBlur={() => {
              void syncServers()
            }}
            className="w-28"
          />
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-idle-shutdown"
        title={t('mcp-servers:runtimeSettings.idleShutdown')}
        description={t('mcp-servers:runtimeSettings.idleShutdownDesc')}
        actions={
          <IdleShutdownInput
            minutes={settings.idleShutdownMinutes ?? 15}
            onCommit={(minutes) => updateSettings({ idleShutdownMinutes: minutes })}
            onBlur={() => {
              void syncServers()
            }}
          />
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-max-tool-output"
        title={t('mcp-servers:runtimeSettings.maxToolOutputChars')}
        description={t('mcp-servers:runtimeSettings.maxToolOutputCharsDesc')}
        actions={
          <Input
            type="number"
            min={0}
            step={1000}
            value={settings.maxToolOutputChars}
            onChange={(event) => updateMaxToolOutputChars(event.target.value)}
            onBlur={() => {
              void syncServers()
            }}
            className="w-28"
          />
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-smart-tool-routing"
        title={t('mcp-servers:runtimeSettings.smartToolRouting')}
        description={t('mcp-servers:runtimeSettings.smartToolRoutingDesc')}
        actions={
          <div className="shrink-0">
            <Switch
              checked={settings.enableSmartToolRouting}
              onCheckedChange={(checked) => {
                if (checked) {
                  updateSettings({ enableSmartToolRouting: true })
                } else {
                  updateSettings({
                    enableSmartToolRouting: false,
                    useLightweightRouterModel: false,
                    routerModelProvider: '',
                    routerModelId: '',
                  })
                }
                void syncServers()
              }}
            />
          </div>
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-lightweight-router"
        title={t('mcp-servers:runtimeSettings.useLightweightRouterModel')}
        description={t(
          'mcp-servers:runtimeSettings.useLightweightRouterModelDesc'
        )}
        actions={
          <div className="shrink-0">
            <Switch
              checked={settings.useLightweightRouterModel}
              disabled={!settings.enableSmartToolRouting}
              onCheckedChange={(checked) => {
                updateSettings(
                  checked
                    ? { useLightweightRouterModel: true }
                    : {
                        useLightweightRouterModel: false,
                        routerModelProvider: '',
                        routerModelId: '',
                      }
                )
                void syncServers()
              }}
            />
          </div>
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-generate-descriptions"
        title={t('mcp-servers:describe.settingTitle')}
        description={t('mcp-servers:describe.settingDesc')}
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={Object.keys(mcpServers).length === 0}
            onClick={() => setDescribeTarget('')}
          >
            {t('mcp-servers:describe.open')}
          </Button>
        }
      />
      <CardItem
        wrapDescription
        anchor="settings-mcp-servers-router-model"
        title={t('mcp-servers:runtimeSettings.routerModel')}
        description={t('mcp-servers:runtimeSettings.routerModelDesc')}
        actions={
          <McpRouterModelPicker
            ariaLabel={t('mcp-servers:runtimeSettings.routerModel')}
            providers={modelProviders}
            selectedProvider={settings.routerModelProvider}
            selectedModelId={settings.routerModelId}
            disabled={routerPickerDisabled}
            onSelect={(providerName, modelId) => {
              updateSettings({
                routerModelProvider: providerName,
                routerModelId: modelId,
              })
              void syncServers()
            }}
            placeholder={t(
              'mcp-servers:runtimeSettings.selectRouterModelPlaceholder'
            )}
            searchPlaceholder={t(
              'mcp-servers:runtimeSettings.routerModelSearchPlaceholder'
            )}
            emptyListMessage={t(
              'mcp-servers:runtimeSettings.routerModelEmptyList'
            )}
            formatEmptySearch={(q) =>
              t('mcp-servers:runtimeSettings.routerModelEmptySearch', {
                query: q,
              })
            }
          />
        }
      />
    </>
  )

  const renderServer = ([key, config]: [string, MCPServerConfig], index: number) => {
    const { authStatus, profile, snapshot } = snapshotFor(key, config)
    const toolNames =
      snapshot.connected || snapshot.enabled ? serverTools[key] : undefined
    const expanded = expandedServers.has(key)
    const off = snapshot.state === 'disabled' || snapshot.state === 'not-installed'
    const color = serverColor(serverEntries.findIndex(([k]) => k === key))
    const series = bucketCounts(
      toolCalls.filter((c) => c.server === key),
      CHART_BUCKETS,
      60_000
    )
    const idSafe = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    return (
      <Frame
        key={`${key}-${index}`}
        data-testid={`mcp-server-${idSafe}`}
        className="motion-safe:animate-rise-in"
        style={{ animationDelay: `${60 + index * 50}ms` }}
        onContextMenu={(e: React.MouseEvent) => {
          e.preventDefault()
          setCtxMenu({ key, x: e.clientX, y: e.clientY })
        }}
      >
        <FrameHeader
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-[length:calc(var(--ui-font-base)*0.8125)] text-foreground">
                {key}
              </span>
              <Chip mono className="h-5 uppercase">
                {config.type || 'stdio'}
              </Chip>
              {config.official && (
                <Chip className="h-5">
                  <img
                    src="/images/flint-logo.png"
                    alt="Flint"
                    className="size-3 object-contain"
                  />
                  <span>{t('uiLeftovers:official')}</span>
                </Chip>
              )}
            </span>
          }
          icon={
            <span
              aria-hidden
              style={{ ['--c' as string]: color }}
              className="grid size-[26px] place-items-center rounded-lg bg-[color-mix(in_oklab,var(--c)_16%,transparent)] text-xs font-bold text-[var(--c)] shadow-[inset_0_0_0_0.8px_color-mix(in_oklab,var(--c)_30%,transparent)]"
            >
              {key.trim().charAt(0).toUpperCase()}
            </span>
          }
          actions={
            <Switch
              checked={snapshot.switchOn}
              loading={!!loadingServers[key] || snapshot.state === 'connecting'}
              aria-label={t('mcp-servers:connection.toggleLabel', {
                serverName: key,
              })}
              aria-describedby={
                snapshot.failure ? mcpServerErrorId(key) : undefined
              }
              onCheckedChange={(checked) => toggleServer(key, checked)}
            />
          }
        />
        <FrameBody className={cn('gap-2.5 p-3', off && '[&>*:not(footer)]:opacity-70')}>
          <div className="flex items-start justify-between gap-2 text-xs">
            <McpServerStatus
              compact
              serverName={key}
              snapshot={snapshot}
              toolNames={toolNames}
              canAuthorize={!!authStatus?.canAuthenticate}
              onRetry={() => toggleServer(key, true)}
              onAuthorize={() => void handleAuthorize(key)}
            />
            <span className="shrink-0 pt-0.5 text-muted-foreground tabular-nums">
              {toolNames
                ? t('engine:mcp.toolsCount', { count: toolNames.length })
                : '—'}
            </span>
          </div>
          <LiveChart
            series={series}
            // One accent for every server: the avatar already says which one it is.
            color="var(--series-a)"
            readout={{
              now: t('engine:chart.now'),
              ago: (count) => t('engine:chart.ago', { count }),
              windowStart: t('engine:chart.ago', { count: CHART_BUCKETS }),
              unit: t('engine:chart.calls'),
            }}
            // Recorded calls stay visible after a server stops; only a
            // server with nothing in the window reads as off.
            off={!snapshot.connected && series.every((v) => v === 0)}
            label={t('engine:mcp.callsPerMin')}
            windowLabel={t('engine:mcp.window', { count: CHART_BUCKETS })}
            peakLabel={t('engine:chart.peak')}
            avgLabel={t('engine:chart.avg')}
            format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
          />
          <p className="m-0 line-clamp-2 min-h-[34px] font-mono text-[length:calc(var(--ui-font-base)*0.71875)] leading-normal text-muted-foreground">
            {toolNames && toolNames.length > 0
              ? t('mcp-servers:connection.toolsAvailable', {
                  count: toolNames.length,
                  names: toolNames.join(' · '),
                })
              : config.official
                ? t('engine:mcp.needsExtension')
                : t('mcp-servers:connection.toolsWhenConnected')}
          </p>
          {selfApprovalToolsOf(toolNames).length > 0 && (
            <p
              role="note"
              data-testid={`mcp-self-approval-${idSafe}`}
              className="m-0 rounded-md bg-warning-tint px-2 py-1 text-[length:calc(var(--ui-font-base)*0.71875)] leading-normal text-warning"
            >
              {t('mcp-servers:selfApproval.note', {
                names: selfApprovalToolsOf(toolNames).join(', '),
              })}
            </p>
          )}
          {expanded && (
            <div className="min-w-0 border-t border-dashed border-border pt-2 text-xs text-muted-foreground">
              <div className="mb-1">
                Transport:{' '}
                <span className="font-mono text-xs uppercase text-fg-2">
                  {config.type || 'stdio'}
                </span>
              </div>

              {config.type === 'stdio' || !config.type ? (
                <>
                  <div className="break-all">
                    {t('mcp-servers:command')}:{' '}
                    <span className="font-mono text-xs text-fg-2">
                      {config.command}
                    </span>
                  </div>
                  <div className="my-1 break-all">
                    {t('mcp-servers:args')}:{' '}
                    <span className="font-mono text-xs text-fg-2">
                      {config?.args?.join(', ')}
                    </span>
                  </div>
                  {config.env && Object.keys(config.env).length > 0 && (
                    <div className="break-all">
                      {t('mcp-servers:env')}:{' '}
                      {Object.entries(config.env)
                        .map(([key]) => `${key}=******`)
                        .join(', ')}
                    </div>
                  )}
                  {config.official && (
                    <div className="mt-2 pt-2 text-xs text-muted-foreground">
                      <p className="mb-1">
                        {t('mcp-servers:browserExtension.requires')}
                      </p>
                      <a
                        href="https://chromewebstore.google.com/detail/jan-browser-mcp/mkciifcjehgnpaigoiaakdgabbpfppal"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-acc-text underline-offset-4 hover:underline"
                      >
                        {t('mcp-servers:browserExtension.install')}
                      </a>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="break-all">
                    URL:{' '}
                    <span className="font-mono text-xs text-fg-2">
                      {maskSensitiveUrl(config.url || '')}
                    </span>
                  </div>
                  {config.headers && Object.keys(config.headers).length > 0 && (
                    <div className="my-1 break-all">
                      Headers:{' '}
                      {Object.entries(config.headers)
                        .map(([key]) => `${key}=******`)
                        .join(', ')}
                    </div>
                  )}
                  {config.timeout && <div>Timeout: {config.timeout}s</div>}
                  <McpServerAuth
                    status={authStatuses[key]}
                    authorizing={!!authorizing[key]}
                    consentUrl={consentUrls[key]}
                    onAuthorize={() => void handleAuthorize(key)}
                    onClearAuth={() => void handleClearAuth(key)}
                  />
                </>
              )}
            </div>
          )}
          {snapshot.enabled && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
              data-testid={`mcp-lifecycle-${idSafe}`}
            >
              <label className="flex items-center gap-2">
                <Switch
                  checked={!!config.startWithFlint}
                  aria-label={t('mcp-servers:lifecycle.startWithFlint')}
                  onCheckedChange={(checked) =>
                    void setStartWithFlint(key, config, checked)
                  }
                />
                <span>{t('mcp-servers:lifecycle.startWithFlint')}</span>
              </label>
              <label className="flex items-center gap-2">
                <span>{t('mcp-servers:lifecycle.toolTimeout')}</span>
                <ServerToolTimeoutInput
                  seconds={config.toolCallTimeoutSeconds}
                  placeholder={String(settings.toolCallTimeoutSeconds)}
                  ariaLabel={t('mcp-servers:lifecycle.toolTimeout')}
                  onCommit={(seconds) =>
                    void setServerToolTimeout(key, config, seconds)
                  }
                />
              </label>
              {snapshot.connected ? (
                <button
                  type="button"
                  className="rounded-md border border-border px-2 py-0.5 text-fg-2 hover:bg-secondary"
                  onClick={() => void stopNow(key)}
                >
                  {t('mcp-servers:lifecycle.stop')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={snapshot.state === 'connecting'}
                  className="rounded-md border border-border px-2 py-0.5 text-fg-2 hover:bg-secondary disabled:opacity-50"
                  onClick={() => void startNow(key)}
                >
                  {t('mcp-servers:lifecycle.start')}
                </button>
              )}
            </div>
          )}
          <McpServerDetails
            profile={profile}
            serverName={key}
            onGenerateDescription={() => setDescribeTarget(key)}
            toolNames={toolNames}
            authStateLabel={
              authStatus
                ? t(`mcp-servers:auth.state.${authStatus.state}`)
                : undefined
            }
          />
          {approvalChanged(key) && (
            <p
              id={`mcp-approval-changed-${idSafe}`}
              className="m-0 text-xs text-warning"
            >
              {t('mcp-servers:approval.changedSinceApproval')}
            </p>
          )}
          <footer className="flex items-center gap-1 border-t border-dashed border-border pt-2">
            <label
              className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium text-secondary-foreground sm:min-h-0"
              title={autoApproveHint}
            >
              <Switch
                checked={isServerApproved(key, fingerprints[key])}
                aria-label={t('mcp-servers:autoApproveServer')}
                aria-describedby={
                  approvalChanged(key)
                    ? `mcp-approval-changed-${idSafe}`
                    : undefined
                }
                onCheckedChange={(checked) =>
                  void handleAutoApprove(key, checked)
                }
              />
              {t('engine:mcp.autoApprove')}
            </label>
            <span className="flex-1" />
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground pointer-coarse:size-11"
              onClick={() => setLogServer(key)}
              title={t('mcp-servers:serverLog.title', { serverName: key })}
              aria-label={t('mcp-servers:serverLog.title', { serverName: key })}
            >
              <FileText aria-hidden />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground pointer-coarse:size-11"
              onClick={() => handleEdit(key)}
              title={t('mcp-servers:editServer')}
              aria-label={`${t('mcp-servers:editServer')}: ${key}`}
            >
              <Pencil aria-hidden />
            </Button>
            <RowMenu
              label={t('engine:mcp.moreActions', { serverName: key })}
              items={[
                {
                  label: t(
                    expanded
                      ? 'mcp-servers:collapseServer'
                      : 'mcp-servers:expandServer'
                  ),
                  icon: expanded ? <ChevronUp /> : <ChevronDown />,
                  onSelect: () => toggleExpanded(key),
                },
                {
                  label: t('mcp-servers:editJson.title', { serverName: key }),
                  icon: <Braces />,
                  onSelect: () => void handleOpenJsonEditor(key),
                },
                {
                  label: snapshot.switchOn
                    ? t('mcp-servers:connection.disable')
                    : t('mcp-servers:connection.enable'),
                  icon: <Power />,
                  onSelect: () => toggleServer(key, !snapshot.switchOn),
                },
                'separator',
                {
                  label: t('mcp-servers:deleteServer.title'),
                  icon: <Trash2 />,
                  destructive: true,
                  onSelect: () => handleDeleteClick(key),
                },
              ]}
            />
          </footer>
        </FrameBody>
      </Frame>
    )
  }

  /** One dense line per server, for when there are too many for cards. */
  const renderRow = ([key, config]: [string, MCPServerConfig]) => {
    const { authStatus, snapshot } = snapshotFor(key, config)
    const toolNames =
      snapshot.connected || snapshot.enabled ? serverTools[key] : undefined
    const color = serverColor(serverEntries.findIndex(([k]) => k === key))
    const idSafe = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    return (
      <div
        key={key}
        data-testid={`mcp-server-${idSafe}`}
        className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
        onContextMenu={(e: React.MouseEvent) => {
          e.preventDefault()
          setCtxMenu({ key, x: e.clientX, y: e.clientY })
        }}
      >
        <span
          aria-hidden
          style={{ ['--c' as string]: color }}
          className="grid size-[22px] shrink-0 place-items-center rounded-md bg-[color-mix(in_oklab,var(--c)_16%,transparent)] text-[length:calc(var(--ui-font-base)*0.6875)] font-bold text-[var(--c)]"
        >
          {key.trim().charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-[length:calc(var(--ui-font-base)*0.8125)] text-foreground">
            {key}
          </span>
          <Chip mono className="h-5 shrink-0 uppercase">
            {config.type || 'stdio'}
          </Chip>
          {config.official && <Chip className="h-5 shrink-0">{t('uiLeftovers:official')}</Chip>}
        </span>
        <span className="hidden min-w-0 shrink-0 text-xs @min-[40rem]:block">
          <McpServerStatus
            compact
            serverName={key}
            snapshot={snapshot}
            toolNames={toolNames}
            canAuthorize={!!authStatus?.canAuthenticate}
            onRetry={() => toggleServer(key, true)}
            onAuthorize={() => void handleAuthorize(key)}
          />
        </span>
        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {toolNames
            ? t('engine:mcp.toolsCount', { count: toolNames.length })
            : '—'}
        </span>
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-secondary-foreground"
          title={autoApproveHint}
        >
          <Switch
            checked={isServerApproved(key, fingerprints[key])}
            aria-label={t('mcp-servers:autoApproveServer')}
            onCheckedChange={(checked) => void handleAutoApprove(key, checked)}
          />
          <span className="hidden @min-[48rem]:inline">
            {t('engine:mcp.autoApprove')}
          </span>
        </label>
        <Switch
          checked={snapshot.switchOn}
          loading={!!loadingServers[key] || snapshot.state === 'connecting'}
          aria-label={t('mcp-servers:connection.toggleLabel', {
            serverName: key,
          })}
          onCheckedChange={(checked) => toggleServer(key, checked)}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => handleEdit(key)}
          title={t('mcp-servers:editServer')}
          aria-label={`${t('mcp-servers:editServer')}: ${key}`}
        >
          <Pencil aria-hidden />
        </Button>
        <RowMenu
          label={t('engine:mcp.moreActions', { serverName: key })}
          items={[
            {
              label: t('mcp-servers:serverLog.title', { serverName: key }),
              icon: <FileText />,
              onSelect: () => setLogServer(key),
            },
            {
              label: t('mcp-servers:editJson.title', { serverName: key }),
              icon: <Braces />,
              onSelect: () => void handleOpenJsonEditor(key),
            },
            'separator',
            {
              label: t('mcp-servers:deleteServer.title'),
              icon: <Trash2 />,
              destructive: true,
              onSelect: () => handleDeleteClick(key),
            },
          ]}
        />
      </div>
    )
  }

  return (
    <Fragment>
      <div className="flex h-full w-full flex-col">
        <SettingsPageHeader title={t('common:mcp-servers')} />
        <SettingsWithSections>
        <EnginePage testId="tools-page">
          <PageHead
            title={t('engine:mcp.title')}
            description={t('engine:mcp.description')}
            actions={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  onClick={() => handleOpenJsonEditor()}
                  title={t('mcp-servers:editAllJson')}
                  aria-label={t('mcp-servers:editAllJson')}
                >
                  <Braces aria-hidden />
                  {t('engine:mcp.editJson')}
                </Button>
                <Button
                  size="sm"
                  className="pointer-coarse:h-11"
                  onClick={() => handleOpenDialog()}
                >
                  <Icon name="x-plus-w" size={14} />
                  {t('mcp-servers:addServer')}
                </Button>
              </>
            }
          />

          <McpKpiRow
            serverCount={serverEntries.length}
            connectedCount={connectedCount}
            connectingCount={connectingCount}
            toolCount={toolCount}
            callsToday={callsToday.length}
            failedToday={failedToday}
            approvedCount={approvedCount}
            allowAllMCPPermissions={allowAllMCPPermissions}
          />

          <div className="flex flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-delay:220ms]">
            <SettingsTabStrip<ToolsTab>
              label={t('common:mcp-servers')}
              tabs={tabs}
              value={tab}
              onChange={setTab}
            />
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Chip tone="warn" className="h-5">
                {t('mcp-servers:experimental')}
              </Chip>
              {t('mcp-servers:findMore')}{' '}
              <a
                href="https://mcp.so/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-acc-text underline-offset-4 hover:underline"
              >
                mcp.so
              </a>
            </span>
            {tab === 'servers' && serverEntries.length > 0 && (
              <McpServerSearch
                value={searchQuery}
                onChange={setSearchQuery}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                view={effectiveView}
                onViewChange={setView}
              />
            )}
          </div>

          {tab === 'routing' ? (
            <Frame className="motion-safe:animate-rise-in">
              <FrameHeader
                icon={<SlidersHorizontal />}
                title={t('mcp-servers:title')}
              />
              <FrameBody className="px-3">{settingsRows}</FrameBody>
            </Frame>
          ) : serverEntries.length === 0 ? (
            <Frame>
              <FrameBody>
                <EmptyState
                  icon={<Icon name="flow" size={20} />}
                  title={t('mcp-servers:noServers')}
                  action={
                    <Button size="sm" onClick={() => handleOpenDialog()}>
                      <Plus aria-hidden />
                      {t('mcp-servers:addServer')}
                    </Button>
                  }
                />
              </FrameBody>
            </Frame>
          ) : filtered.length === 0 ? (
            <Frame>
              <FrameBody>
                <EmptyState
                  icon={<Icon name="flow" />}
                  title={t('mcp-servers:noSearchResults', { query: searchQuery })}
                />
              </FrameBody>
            </Frame>
          ) : effectiveView === 'list' ? (
            <div className="@container flex flex-col gap-3">
              <Frame className="motion-safe:animate-rise-in">
                <FrameBody className="p-0">{filtered.map(renderRow)}</FrameBody>
              </Frame>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => handleOpenDialog()}
              >
                <Plus aria-hidden />
                {t('mcp-servers:addServer')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4">
              {filtered.map(renderServer)}
              <button
                type="button"
                onClick={() => handleOpenDialog()}
                style={{ animationDelay: `${60 + filtered.length * 50}ms` }}
                className="flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground motion-safe:animate-rise-in"
              >
                <Icon name="x-plus" />
                {t('engine:mcp.addTile')}
                <small className="text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
                  {t('engine:mcp.addTileHint')}
                </small>
              </button>
            </div>
          )}

          {ctxMenu && (
            <McpServerContextMenu
              ctxMenu={ctxMenu}
              switchOn={
                mcpServers[ctxMenu.key]
                  ? snapshotFor(ctxMenu.key, mcpServers[ctxMenu.key]).snapshot
                      .switchOn
                  : null
              }
              onClose={() => setCtxMenu(null)}
              onLog={setLogServer}
              onEdit={handleEdit}
              onToggle={toggleServer}
              onDelete={handleDeleteClick}
            />
          )}
        </EnginePage>
        </SettingsWithSections>
      </div>

      {/* Use the AddEditMCPServer component */}
      <AddEditMCPServer
        open={open}
        onOpenChange={setOpen}
        editingKey={editingKey}
        initialData={currentConfig}
        onSave={handleSaveServer}
        existingNames={Object.keys(mcpServers)}
      />

      <McpDescriptionGenerator
        open={describeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDescribeTarget(null)
        }}
        servers={mcpServers}
        connectedServers={connectedServers}
        onlyServer={describeTarget || undefined}
        onSave={(descriptions) => {
          for (const [name, description] of Object.entries(descriptions)) {
            const config = mcpServers[name]
            if (config) editServer(name, { ...config, description })
          }
          void syncServers()
        }}
      />
      <McpServerLogDialog
        open={logServer !== null}
        onOpenChange={(o) => !o && setLogServer(null)}
        serverName={logServer ?? ''}
      />

      {/* Delete confirmation dialog */}
      <DeleteMCPServerConfirm
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        serverName={serverToDelete || ''}
        onConfirm={handleConfirmDelete}
      />

      {/* JSON editor dialog */}
      <EditJsonMCPserver
        open={jsonEditorOpen}
        onOpenChange={setJsonEditorOpen}
        serverName={jsonServerName}
        initialData={
          jsonEditorData ?? {
            mcpServers,
            mcpSettings: settings,
          }
        }
        onSave={handleSaveJson}
      />
    </Fragment>
  )
}
