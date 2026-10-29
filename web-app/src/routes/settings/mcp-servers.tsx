import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { SettingsPageHeader, SettingsWithSections } from '@/containers/SettingsPageHeader'
import { Braces, Plus, SlidersHorizontal } from 'lucide-react'
import {
  useMCPServers,
  MCPServerConfig,
  MCPSettings,
  DEFAULT_MCP_SETTINGS,
} from '@/hooks/useMCPServers'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import AddEditMCPServer from '@/containers/dialogs/AddEditMCPServer'
import DeleteMCPServerConfirm from '@/containers/dialogs/DeleteMCPServerConfirm'
import EditJsonMCPserver from '@/containers/dialogs/EditJsonMCPserver'
import McpServerLogDialog from '@/containers/dialogs/McpServerLogDialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useToolApproval } from '@/hooks/useToolApproval'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { Button } from '@/components/ui/button'
import { useModelProvider } from '@/hooks/useModelProvider'
import { McpDescriptionGenerator } from '@/containers/dialogs/McpDescriptionGenerator'
import { isRouterModelSelectable } from '@/lib/mcp-router-model-filter'
import { useMcpAuth } from '@/hooks/useMcpAuth'
import { useMcpServerLifecycle } from '@/hooks/useMcpServerLifecycle'
import { deriveConnectionState, runtimeCleared } from '@/lib/mcpConnectionState'
import { deriveMcpServerProfile } from '@/lib/mcpServerProfile'
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
import {
  startOfToday,
  useEngineActivity,
} from '@/stores/engine-activity-store'
import { Icon } from '@/components/ui/icon'
import { McpServerCard, type McpServerHandlers } from '@/containers/McpServerCard'
import { McpServerRow } from '@/containers/McpServerRow'
import { McpRuntimeSettings } from '@/containers/McpRuntimeSettings'

type ToolsTab = 'servers' | 'routing'
type ServersView = 'cards' | 'list'
const SERVERS_VIEW_KEY = 'flint-mcp-servers-view'

export const Route = createFileRoute(route.settings.mcp_servers)({
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


  const modelProviders = useModelProvider((state) => state.providers)


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

  const handlers: McpServerHandlers = {
    onContextMenu: (key, x, y) => setCtxMenu({ key, x, y }),
    onToggle: (key, checked) => void toggleServer(key, checked),
    onAuthorize: (key) => void handleAuthorize(key),
    onClearAuth: (key) => void handleClearAuth(key),
    onAutoApprove: (key, checked) => void handleAutoApprove(key, checked),
    onLog: setLogServer,
    onEdit: handleEdit,
    onEditJson: (key) => void handleOpenJsonEditor(key),
    onDelete: handleDeleteClick,
    onToggleExpanded: toggleExpanded,
    onDescribe: setDescribeTarget,
    onStartNow: (key) => void startNow(key),
    onStopNow: (key) => void stopNow(key),
    onSetStartWithFlint: (key, config, checked) =>
      void setStartWithFlint(key, config, checked),
    onSetToolTimeout: (key, config, seconds) =>
      void setServerToolTimeout(key, config, seconds),
  }
  const itemProps = ([key, config]: [string, MCPServerConfig]) => {
    const view = snapshotFor(key, config)
    return {
      serverKey: key,
      config,
      position: serverEntries.findIndex(([k]) => k === key),
      view,
      toolNames:
        view.snapshot.connected || view.snapshot.enabled
          ? serverTools[key]
          : undefined,
      loading: !!loadingServers[key],
      approved: isServerApproved(key, fingerprints[key]),
      handlers,
    }
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
              <FrameBody className="px-3">
                <McpRuntimeSettings
                  settings={settings}
                  updateSettings={updateSettings}
                  syncServers={syncServers}
                  modelProviders={modelProviders}
                  hasServers={serverEntries.length > 0}
                  onDescribeAll={() => setDescribeTarget('')}
                />
              </FrameBody>
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
                <FrameBody className="p-0">
                  {filtered.map((entry) => (
                    <McpServerRow key={entry[0]} {...itemProps(entry)} />
                  ))}
                </FrameBody>
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
              {filtered.map((entry, index) => {
                const [key] = entry
                return (
                  <McpServerCard
                    key={`${key}-${index}`}
                    {...itemProps(entry)}
                    index={index}
                    expanded={expandedServers.has(key)}
                    approvalChanged={approvalChanged(key)}
                    toolCalls={toolCalls}
                    defaultToolTimeoutSeconds={settings.toolCallTimeoutSeconds}
                    authorizing={!!authorizing[key]}
                    consentUrl={consentUrls[key]}
                  />
                )
              })}
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
