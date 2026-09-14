import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card, CardItem } from '@/containers/Card'
import { Braces, FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  useMCPServers,
  MCPServerConfig,
  MCPSettings,
  DEFAULT_MCP_SETTINGS,
} from '@/hooks/useMCPServers'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
import { resolveServerFingerprints } from '@/lib/mcpServerIdentity'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { listen } from '@tauri-apps/api/event'
import { SystemEvent } from '@/types/events'
import { Button } from '@/components/ui/button'
import { useModelProvider } from '@/hooks/useModelProvider'
import { McpRouterModelPicker } from '@/containers/McpRouterModelPicker'
import { isRouterModelSelectable } from '@/lib/mcp-router-model-filter'
import { normalizeAppError } from '@/utils/appError'
import { McpServerAuth } from '@/containers/McpServerAuth'
import { useMcpAuth } from '@/hooks/useMcpAuth'
import {
  activationConfirmed,
  activationFailed,
  beginActivation,
  classifyActivationFailure,
  deriveConnectionState,
  runtimeCleared,
  type McpServerRuntime,
} from '@/lib/mcpConnectionState'
import { deriveMcpServerProfile, transportOf } from '@/lib/mcpServerProfile'
import {
  McpServerDetails,
  McpServerStatus,
  mcpServerErrorId,
} from '@/containers/McpServerConnectionDetails'


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
    setAllowAllMCPPermissions,
    isServerApproved,
    approveServerTrust,
    revokeServerTrust,
    forgetServer,
    approvedServers,
    invalidatedServers,
  } = useToolApproval()

  const [open, setOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [currentConfig, setCurrentConfig] = useState<
    MCPServerConfig | undefined
  >(undefined)

  // Per-server log dialog state (AH-140)
  const [logServer, setLogServer] = useState<string | null>(null)

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
  const [connectedServers, setConnectedServers] = useState<string[]>([])
  const [loadingServers, setLoadingServers] = useState<{
    [key: string]: boolean
  }>({})
  const {
    statuses: authStatuses,
    authorizing,
    consentUrls,
    refresh: refreshAuth,
    authorize,
    clearAuth,
  } = useMcpAuth(Object.keys(mcpServers))

  const refreshConnectedServers = useCallback(() => {
    serviceHub
      .mcp()
      .getConnectedServers()
      .then(setConnectedServers)
      .catch((error) =>
        console.error('Failed to refresh connected MCP servers:', error)
      )
  }, [serviceHub])
  const setErrorMessage = useAppState((state) => state.setErrorMessage)

  /** In-flight activation and last failure per server; see mcpConnectionState. */
  const [runtime, setRuntime] = useState<Record<string, McpServerRuntime>>({})
  /**
   * Each server's security fingerprint, as the backend computes it from the
   * saved or running definition. Auto-approve is bound to it, so an edit that
   * changes what runs shows as needing renewed approval.
   */
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({})
  const refreshFingerprints = useCallback(async () => {
    const next = await resolveServerFingerprints()
    setFingerprints(next)
    return next
  }, [])
  const serversSignature = JSON.stringify(mcpServers)
  useEffect(() => {
    void refreshFingerprints()
  }, [serversSignature, refreshFingerprints])

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
  const connectedKey = connectedServers.join('\u0000')

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

    const numericValue = Number(rawValue)
    if (!Number.isNaN(numericValue)) {
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
      // If server name changed, rename it while preserving position
      if (editingKey !== name) {
        toggleServer(editingKey, false)
        renameServer(editingKey, name, config)
        toggleServer(name, true)
        // Grants never follow a rename: the approval was for the old name,
        // and its OAuth tokens may belong to an endpoint the edit changed.
        forgetServerGrants(editingKey, 'renamed', name)
        // Restart servers to update tool references with new server name
        syncServersAndRestart()
      } else {
        toggleServer(editingKey, false)
        editServer(editingKey, config)
        toggleServer(editingKey, true)
        syncServers()
      }
    } else {
      // Add new server
      toggleServer(name, false)
      addServer(name, config)
      toggleServer(name, true)
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
      try {
        toggleServer(jsonServerName, false)
      } catch (error) {
        console.error('Error deactivating server:', error)
      }
      // Save single server
      editServer(jsonServerName, data as MCPServerConfig)
      toggleServer(jsonServerName, (data as MCPServerConfig).active || false)
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

      // Clear existing servers first
      Object.keys(mcpServers).forEach((serverKey) => {
        toggleServer(serverKey, false)
        deleteServer(serverKey)
      })

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

  /**
   * Run the interactive sign-in, then bring the server up if it is enabled: a
   * server that failed to connect for want of a token is still marked active,
   * so authorizing without reconnecting would leave it down until toggled.
   */
  const handleAuthorize = async (serverKey: string) => {
    try {
      await authorize(serverKey)
      toast.success(t('mcp-servers:auth.authorized', { serverName: serverKey }))
      // A start that failed for want of sign-in reverted the flag, but the
      // user was trying to turn it on: finish what they started.
      if (
        mcpServers[serverKey]?.active ||
        runtime[serverKey]?.failure?.needsAuth
      ) {
        toggleServer(serverKey, true)
      }
    } catch (error) {
      setErrorMessage({
        message: t('mcp-servers:auth.authorizeFailed', {
          serverName: serverKey,
        }),
        subtitle: normalizeAppError(error),
      })
    }
  }

  /**
   * Forget the tokens and drop the connection: the live transport still holds
   * the old bearer token, so leaving it up would keep working against
   * credentials the user just asked to forget.
   *
   * Disconnect only -- the server stays `active` in the config, so re-authorizing
   * brings it back without the user having to re-enable it. Matches the CLI's
   * `MCP_ACTION_CLEAR_AUTH`, which also clears and disconnects without touching
   * the flag.
   */
  const handleClearAuth = async (serverKey: string) => {
    try {
      const cleared = await clearAuth(serverKey)
      toast.success(
        cleared
          ? t('mcp-servers:auth.cleared', { serverName: serverKey })
          : t('mcp-servers:auth.nothingToClear', { serverName: serverKey })
      )
      if (cleared && connectedServers.includes(serverKey)) {
        await serviceHub.mcp().deactivateMCPServer(serverKey)
        refreshConnectedServers()
      }
    } catch (error) {
      setErrorMessage({
        message: t('mcp-servers:auth.clearFailed', { serverName: serverKey }),
        subtitle: normalizeAppError(error),
      })
    }
  }

  const toggleServer = (serverKey: string, active: boolean) => {
    if (serverKey) {
      setLoadingServers((prev) => ({ ...prev, [serverKey]: true }))
      const config = getServerConfig(serverKey)
      if (active && config) {
        const transport = transportOf(config)
        setRuntime((prev) => ({ ...prev, [serverKey]: beginActivation() }))
        let started = false
        serviceHub
          .mcp()
          .activateMCPServer(serverKey, { ...config, active })
          .then(async () => {
            started = true
            // `activate` resolving means the first start attempt returned.
            // Only the backend's connected list says the server is up, so
            // nothing is saved or announced until it appears there.
            const connected = await serviceHub.mcp().getConnectedServers()
            setConnectedServers(connected)
            if (!connected.includes(serverKey)) {
              throw new Error(t('mcp-servers:connection.notListedAfterStart'))
            }
            editServer(serverKey, { ...config, active })
            syncServers()
            setRuntime((prev) => ({
              ...prev,
              [serverKey]: activationConfirmed(),
            }))
            toast.success(t('mcp-servers:serverStatusActive', { serverKey }))
          })
          .catch((error) => {
            if (started) {
              // It started but was not confirmed: stop it, so nothing keeps
              // running behind a switch that shows off.
              void Promise.resolve()
                .then(() => serviceHub.mcp().deactivateMCPServer(serverKey))
                .catch(() => {})
                .finally(refreshConnectedServers)
            }
            editServer(serverKey, { ...config, active: false })
            const failure = classifyActivationFailure(error, transport)
            setRuntime((prev) => ({
              ...prev,
              [serverKey]: activationFailed(failure),
            }))
            // A server that only needs signing in is not a misconfigured one:
            // the backend tags it, so point at the fix rather than telling the
            // user to check parameters they got right.
            if (failure.needsAuth) {
              void refreshAuth()
              setErrorMessage({
                message: t('mcp-servers:auth.needsAuth', {
                  serverName: serverKey,
                }),
                subtitle: t('mcp-servers:auth.needsAuthHint'),
              })
              return
            }
            setErrorMessage({
              message: failure.message,
              subtitle: t('mcp-servers:checkParams'),
            })
          })
          .finally(() => {
            setLoadingServers((prev) => ({ ...prev, [serverKey]: false }))
          })
      } else {
        setRuntime((prev) => ({ ...prev, [serverKey]: runtimeCleared() }))
        editServer(serverKey, {
          ...(config ?? (mcpServers[serverKey] as MCPServerConfig)),
          active,
        })
        syncServers()
        serviceHub
          .mcp()
          .deactivateMCPServer(serverKey)
          .finally(() => {
            refreshConnectedServers()
            setLoadingServers((prev) => ({ ...prev, [serverKey]: false }))
          })
      }
    }
  }

  useEffect(() => {
    refreshConnectedServers()

    let unlisten: (() => void) | undefined
    const setupListener = async () => {
      unlisten = await listen(SystemEvent.MCP_UPDATE, () => {
        refreshConnectedServers()
      })
    }
    setupListener().catch((error) =>
      console.error('Failed to set up MCP update listener:', error)
    )

    return () => {
      unlisten?.()
    }
  }, [refreshConnectedServers])

  return (
    <Fragment>
      <div className="flex flex-col h-full w-full">
        <SettingsPageHeader title={t('common:mcp-servers')}>
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => handleOpenDialog()}
          >
            <Plus aria-hidden />
            {t('mcp-servers:addServer')}
          </Button>
        </SettingsPageHeader>
        <SettingsPageBody
          title={t('common:mcp-servers')}
          description={t('settings:pageDesc.mcpServers')}
        >
          <Card
            title={
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                {t('mcp-servers:title')}
                <span className="rounded-md bg-warning-tint px-1.5 py-0.5 text-xs font-medium text-warning">
                  {t('mcp-servers:experimental')}
                </span>
              </span>
            }
            aside={
              <Button
                onClick={() => handleOpenJsonEditor()}
                title={t('mcp-servers:editAllJson')}
                aria-label={t('mcp-servers:editAllJson')}
                size="icon-sm"
                variant="outline"
                className="pointer-coarse:size-11"
              >
                <Braces className="text-muted-foreground" aria-hidden />
              </Button>
            }
            description={
              <>
                {t('mcp-servers:findMore')}{' '}
                <a
                  href="https://mcp.so/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-text underline-offset-4 hover:underline"
                >
                  mcp.so
                </a>
              </>
            }
          >
            <CardItem
              anchor="settings-mcp-servers-allow-permissions"
              title={t('mcp-servers:allowPermissions')}
              description={t('mcp-servers:allowPermissionsDesc')}
              actions={
                <div className="shrink-0">
                  <Switch
                    checked={allowAllMCPPermissions}
                    onCheckedChange={setAllowAllMCPPermissions}
                  />
                </div>
              }
            />
            <CardItem
              anchor="settings-mcp-servers-tool-call-timeout"
              title={t('mcp-servers:runtimeSettings.toolCallTimeout')}
              description={t(
                'mcp-servers:runtimeSettings.toolCallTimeoutDesc'
              )}
              actions={
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={settings.toolCallTimeoutSeconds}
                  onChange={(event) =>
                    updateToolCallTimeout(event.target.value)
                  }
                  onBlur={() => {
                    void syncServers()
                  }}
                  className="w-28"
                />
              }
            />
            <CardItem
              anchor="settings-mcp-servers-max-tool-output"
              title={t('mcp-servers:runtimeSettings.maxToolOutputChars')}
              description={t(
                'mcp-servers:runtimeSettings.maxToolOutputCharsDesc'
              )}
              actions={
                <Input
                  type="number"
                  min={0}
                  step={1000}
                  value={settings.maxToolOutputChars}
                  onChange={(event) =>
                    updateMaxToolOutputChars(event.target.value)
                  }
                  onBlur={() => {
                    void syncServers()
                  }}
                  className="w-28"
                />
              }
            />
            <CardItem
              anchor="settings-mcp-servers-smart-tool-routing"
              title={t('mcp-servers:runtimeSettings.smartToolRouting')}
              description={t(
                'mcp-servers:runtimeSettings.smartToolRoutingDesc'
              )}
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
          </Card>

          {Object.keys(mcpServers).length === 0 ? (
            <div className="rounded-lg border border-dashed border-line-strong bg-card px-4 py-8 text-center font-medium text-muted-foreground">
              {t('mcp-servers:noServers')}
            </div>
          ) : (
            Object.entries(mcpServers).map(([key, config], index) => {
              const authStatus = authStatuses[key]
              const profile = deriveMcpServerProfile(config, authStatus)
              const snapshot = deriveConnectionState({
                installed: true,
                enabled: !!config.active,
                connected: connectedServers.includes(key),
                runtime: runtime[key],
                authStatus,
                transport: profile.transport,
              })
              const toolNames = snapshot.connected
                ? serverTools[key]
                : undefined
              return (
              <Card key={`${key}-${index}`}>
                <CardItem
                  align="start"
                  title={
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {/* The connection state is the chip under the
                          title; a coloured dot here only repeated it. */}
                      <h3 className="min-w-0 break-words text-sm font-semibold text-foreground">
                        {key}
                      </h3>
                      {config.official && (
                        <div className="flex items-center gap-1.5 rounded-sm bg-sunken px-2 py-0.5 text-xs text-ink-2">
                          <img
                            src="/images/jan-logo.png"
                            alt="Jan"
                            className="w-3 h-3 object-contain"
                          />
                          <span>Official</span>
                        </div>
                      )}
                    </div>
                  }
                  descriptionOutside={
                    <div className="min-w-0 pt-2 text-sm text-muted-foreground">
                      <div className="mb-1">
                        Transport:{' '}
                        <span className="font-mono text-xs uppercase text-ink-2">
                          {config.type || 'stdio'}
                        </span>
                      </div>

                      {config.type === 'stdio' || !config.type ? (
                        <>
                          <div className="break-all">
                            {t('mcp-servers:command')}:{' '}
                            <span className="font-mono text-xs text-ink-2">
                              {config.command}
                            </span>
                          </div>
                          <div className="my-1 break-all">
                            {t('mcp-servers:args')}:{' '}
                            <span className="font-mono text-xs text-ink-2">
                              {config?.args?.join(', ')}
                            </span>
                          </div>
                          {config.env &&
                            Object.keys(config.env).length > 0 && (
                              <div className="break-all">
                                {t('mcp-servers:env')}:{' '}
                                {Object.entries(config.env)
                                  .map(([key]) => `${key}=******`)
                                  .join(', ')}
                              </div>
                            )}
                          {config.official && (
                            <div className="mt-2 text-xs text-muted-foreground pt-2">
                              <p className="mb-1">
                                Requires Jan Browser Extension to be installed
                                in your Chrome-based browser.
                              </p>
                              <a
                                href="https://chromewebstore.google.com/detail/jan-browser-mcp/mkciifcjehgnpaigoiaakdgabbpfppal"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-brand-text underline-offset-4 hover:underline"
                              >
                                Install Extension →
                              </a>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="break-all">
                            URL:{' '}
                            <span className="font-mono text-xs text-ink-2">
                              {maskSensitiveUrl(config.url || '')}
                            </span>
                          </div>
                          {config.headers &&
                            Object.keys(config.headers).length > 0 && (
                              <div className="my-1 break-all">
                                Headers:{' '}
                                {Object.entries(config.headers)
                                  .map(([key]) => `${key}=******`)
                                  .join(', ')}
                              </div>
                            )}
                          {config.timeout && (
                            <div>Timeout: {config.timeout}s</div>
                          )}
                          <McpServerAuth
                            status={authStatuses[key]}
                            authorizing={!!authorizing[key]}
                            consentUrl={consentUrls[key]}
                            onAuthorize={() => void handleAuthorize(key)}
                            onClearAuth={() => void handleClearAuth(key)}
                          />
                        </>
                      )}
                      <McpServerStatus
                        serverName={key}
                        snapshot={snapshot}
                        toolNames={toolNames}
                        canAuthorize={!!authStatus?.canAuthenticate}
                        onRetry={() => toggleServer(key, true)}
                        onAuthorize={() => void handleAuthorize(key)}
                      />
                      <McpServerDetails
                        profile={profile}
                        toolNames={toolNames}
                        authStateLabel={
                          authStatus
                            ? t(`mcp-servers:auth.state.${authStatus.state}`)
                            : undefined
                        }
                      />
                      <div className="mt-3 flex min-h-11 items-center gap-2 border-t border-border pt-3 sm:min-h-0">
                        <Switch
                          checked={isServerApproved(key, fingerprints[key])}
                          aria-label={t('mcp-servers:autoApproveServer')}
                          aria-describedby={
                            approvalChanged(key)
                              ? `mcp-approval-changed-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
                              : undefined
                          }
                          onCheckedChange={(checked) =>
                            void handleAutoApprove(key, checked)
                          }
                        />
                        <span className="text-foreground">
                          {t('mcp-servers:autoApproveServer')}
                        </span>
                      </div>
                      {approvalChanged(key) && (
                        <p
                          id={`mcp-approval-changed-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`}
                          className="mt-1 text-xs text-warning"
                        >
                          {t('mcp-servers:approval.changedSinceApproval')}
                        </p>
                      )}
                    </div>
                  }
                  actions={
                    <div className="flex flex-wrap items-center justify-start gap-1 sm:justify-end">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="pointer-coarse:size-11"
                        onClick={() => handleOpenJsonEditor(key)}
                        title={t('mcp-servers:editJson.title', {
                          serverName: key,
                        })}
                        aria-label={t('mcp-servers:editJson.title', {
                          serverName: key,
                        })}
                      >
                        <Braces className="text-muted-foreground" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="pointer-coarse:size-11"
                        onClick={() => setLogServer(key)}
                        title={t('mcp-servers:serverLog.title', {
                          serverName: key,
                        })}
                        aria-label={t('mcp-servers:serverLog.title', {
                          serverName: key,
                        })}
                      >
                        <FileText className="text-muted-foreground" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="pointer-coarse:size-11"
                        onClick={() => handleEdit(key)}
                        title={t('mcp-servers:editServer')}
                        aria-label={`${t('mcp-servers:editServer')}: ${key}`}
                      >
                        <Pencil className="text-muted-foreground" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive pointer-coarse:size-11"
                        onClick={() => handleDeleteClick(key)}
                        title={t('mcp-servers:deleteServer.title')}
                        aria-label={`${t('mcp-servers:deleteServer.title')}: ${key}`}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                      <div className="ml-1 flex min-h-11 items-center sm:min-h-0">
                        <Switch
                          checked={snapshot.switchOn}
                          loading={
                            !!loadingServers[key] ||
                            snapshot.state === 'connecting'
                          }
                          aria-label={t('mcp-servers:connection.toggleLabel', {
                            serverName: key,
                          })}
                          aria-describedby={
                            snapshot.failure
                              ? mcpServerErrorId(key)
                              : undefined
                          }
                          onCheckedChange={(checked) =>
                            toggleServer(key, checked)
                          }
                        />
                      </div>
                    </div>
                  }
                />
              </Card>
              )
            })
          )}
        </SettingsPageBody>
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
