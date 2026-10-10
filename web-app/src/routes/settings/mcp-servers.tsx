import type { MCPServerStatus } from '@/services/mcp/types'
import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { SettingsPageHeader, SettingsWithSections } from '@/containers/SettingsPageHeader'
import { CardItem } from '@/containers/Card'
import {
  Braces,
  ChevronDown,
  ChevronUp,
  FileText,
  LayoutGrid,
  List as ListIcon,
  ListFilter,
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
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import AddEditMCPServer from '@/containers/dialogs/AddEditMCPServer'
import DeleteMCPServerConfirm from '@/containers/dialogs/DeleteMCPServerConfirm'
import EditJsonMCPserver from '@/containers/dialogs/EditJsonMCPserver'
import McpServerLogDialog from '@/containers/dialogs/McpServerLogDialog'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useToolApproval } from '@/hooks/useToolApproval'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import { resolveServerFingerprints } from '@/lib/mcpServerIdentity'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { selfApprovalToolsOf } from '@/lib/selfApprovalTools'
import { listen } from '@tauri-apps/api/event'
import { SystemEvent } from '@/types/events'
import { Button } from '@/components/ui/button'
import { useModelProvider } from '@/hooks/useModelProvider'
import { McpRouterModelPicker } from '@/containers/McpRouterModelPicker'
import { McpDescriptionGenerator } from '@/containers/dialogs/McpDescriptionGenerator'
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
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Segmented } from '@/components/ui/segmented'
import {
  EnginePage,
  KpiRow,
  KpiTile,
  PageHead,
  SearchField,
} from '@/containers/engine/EngineKit'
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
  const [tab, setTab] = useState<ToolsTab>('servers')
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

  /** On-demand lifecycle per enabled server (stopped/starting/running/failed). */
  const [lifecycle, setLifecycle] = useState<Record<string, MCPServerStatus>>(
    {}
  )
  const refreshConnectedServers = useCallback(() => {
    serviceHub
      .mcp()
      .getConnectedServers()
      .then(setConnectedServers)
      .catch((error) =>
        console.error('Failed to refresh connected MCP servers:', error)
      )
    Promise.resolve(serviceHub.mcp().getServerStatuses?.())
      .then((next) => setLifecycle(next ?? {}))
      .catch(() => {})
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
        toggleServer(name, true, config)
        // Grants never follow a rename: the approval was for the old name,
        // and its OAuth tokens may belong to an endpoint the edit changed.
        forgetServerGrants(editingKey, 'renamed', name)
        // Restart servers to update tool references with new server name
        syncServersAndRestart()
      } else {
        toggleServer(editingKey, false)
        editServer(editingKey, config)
        toggleServer(editingKey, true, config)
        syncServers()
      }
    } else {
      // Add new server
      toggleServer(name, false)
      addServer(name, config)
      toggleServer(name, true, config)
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

  /** Manual Start: starts now, and lists fresh tools; errors are shown. */
  const startNow = async (serverKey: string) => {
    try {
      await serviceHub.mcp().startMCPServer(serverKey)
    } catch (error) {
      setErrorMessage({
        message: normalizeAppError(error),
        subtitle: t('mcp-servers:checkParams'),
      })
    } finally {
      refreshConnectedServers()
    }
  }

  /** Manual Stop: the server stays on and starts again when needed. */
  const stopNow = async (serverKey: string) => {
    try {
      await serviceHub.mcp().stopMCPServer(serverKey)
    } catch (error) {
      console.error(`Failed to stop MCP server ${serverKey}:`, error)
    } finally {
      refreshConnectedServers()
    }
  }

  const setStartWithFlint = async (
    serverKey: string,
    config: MCPServerConfig,
    startWithFlint: boolean
  ) => {
    const next = { ...config, startWithFlint }
    editServer(serverKey, next)
    syncServers()
    if (config.active) {
      // Refresh the backend's registration so idle shutdown sees the flag;
      // turning it on also starts the server now.
      await Promise.resolve(
        serviceHub.mcp().activateMCPServer(serverKey, next, { start: false })
      ).catch(() => {})
      refreshConnectedServers()
    }
  }

  const toggleServer = (
    serverKey: string,
    active: boolean,
    configOverride?: MCPServerConfig
  ) => {
    if (serverKey) {
      setLoadingServers((prev) => ({ ...prev, [serverKey]: true }))
      // React state updates asynchronously; save can activate a server before
      // its new config appears in mcpServers.
      const config = configOverride ?? getServerConfig(serverKey)
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
    let cancelled = false
    const setupListener = async () => {
      const fn = await listen(SystemEvent.MCP_UPDATE, () => {
        refreshConnectedServers()
      })
      if (cancelled) fn()
      else unlisten = fn
    }
    setupListener().catch((error) =>
      console.error('Failed to set up MCP update listener:', error)
    )

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [refreshConnectedServers])

  const serverEntries = Object.entries(mcpServers)
  const snapshotFor = (key: string, config: MCPServerConfig) => {
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
              <span className="min-w-0 truncate text-[13px] text-foreground">
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
                  <span>Official</span>
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
            color={color}
            // Recorded calls stay visible after a server stops; only a
            // server with nothing in the window reads as off.
            off={!snapshot.connected && series.every((v) => v === 0)}
            label={t('engine:mcp.callsPerMin')}
            windowLabel={t('engine:mcp.window', { count: CHART_BUCKETS })}
            peakLabel={t('engine:chart.peak')}
            avgLabel={t('engine:chart.avg')}
            format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
          />
          <p className="m-0 line-clamp-2 min-h-[34px] font-mono text-[11.5px] leading-normal text-muted-foreground">
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
              className="m-0 rounded-md bg-warning-tint px-2 py-1 text-[11.5px] leading-normal text-warning"
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
                        Requires Jan Browser Extension to be installed in your
                        Chrome-based browser.
                      </p>
                      <a
                        href="https://chromewebstore.google.com/detail/jan-browser-mcp/mkciifcjehgnpaigoiaakdgabbpfppal"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-acc-text underline-offset-4 hover:underline"
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
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium text-secondary-foreground sm:min-h-0">
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
          className="grid size-[22px] shrink-0 place-items-center rounded-md bg-[color-mix(in_oklab,var(--c)_16%,transparent)] text-[11px] font-bold text-[var(--c)]"
        >
          {key.trim().charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] text-foreground">
            {key}
          </span>
          <Chip mono className="h-5 shrink-0 uppercase">
            {config.type || 'stdio'}
          </Chip>
          {config.official && <Chip className="h-5 shrink-0">Official</Chip>}
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
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-secondary-foreground">
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

          <KpiRow>
            <KpiTile
              title={t('engine:mcp.kpiServers')}
              icon={<Icon name="flow" />}
              value={serverEntries.length}
              sub={t('engine:mcp.kpiServersSub', {
                connected: connectedCount,
                connecting: connectingCount,
              })}
              delay={40}
            />
            <KpiTile
              title={t('engine:mcp.kpiTools')}
              icon={<Icon name="x-sparkle" />}
              value={toolCount}
              sub={t('engine:mcp.kpiToolsSub', { count: connectedCount })}
              delay={90}
            />
            <KpiTile
              title={t('engine:mcp.kpiCalls')}
              icon={<Icon name="x-activity" />}
              value={callsToday.length}
              sub={
                callsToday.length > 0
                  ? t('engine:mcp.kpiCallsSub', {
                      pct: ((failedToday / callsToday.length) * 100).toFixed(1),
                    })
                  : t('engine:mcp.kpiCallsNone')
              }
              delay={140}
            />
            <KpiTile
              title={t('engine:mcp.kpiApproved')}
              icon={<Icon name="x-shield" />}
              value={approvedCount}
              sub={
                allowAllMCPPermissions
                  ? t('engine:mcp.kpiApprovedAll')
                  : t('engine:mcp.kpiApprovedSub', {
                      count: serverEntries.length - approvedCount,
                    })
              }
              delay={190}
            />
          </KpiRow>

          <div className="flex flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-delay:220ms]">
            <Segmented<ToolsTab>
              className="w-[320px] max-w-full"
              aria-label={t('common:mcp-servers')}
              value={tab}
              onValueChange={setTab}
              options={[
                { value: 'servers', label: t('engine:mcp.tabServers') },
                { value: 'routing', label: t('engine:mcp.tabRouting') },
              ]}
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
              <SearchField
                className="ml-auto w-[300px] max-w-full"
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={t('mcp-servers:searchPlaceholder')}
                trailing={
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('engine:mcp.filterLabel')}
                          title={t('engine:mcp.filterLabel')}
                          className={cn(statusFilter !== 'all' && 'text-acc-text')}
                        >
                          <ListFilter aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuRadioGroup
                          value={statusFilter}
                          onValueChange={(v) =>
                            setStatusFilter(v as 'all' | 'on' | 'off')
                          }
                        >
                          <DropdownMenuRadioItem value="all">
                            {t('engine:mcp.filterAll')}
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="on">
                            {t('engine:mcp.filterOn')}
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="off">
                            {t('engine:mcp.filterOff')}
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('engine:mcp.viewLabel')}
                      title={
                        effectiveView === 'list'
                          ? t('engine:mcp.viewCards')
                          : t('engine:mcp.viewList')
                      }
                      onClick={() =>
                        setView(effectiveView === 'list' ? 'cards' : 'list')
                      }
                    >
                      {effectiveView === 'list' ? (
                        <LayoutGrid aria-hidden />
                      ) : (
                        <ListIcon aria-hidden />
                      )}
                    </Button>
                  </>
                }
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
                className="flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground motion-safe:animate-rise-in"
              >
                <Icon name="x-plus" />
                {t('engine:mcp.addTile')}
                <small className="text-[11.5px] text-muted-foreground">
                  {t('engine:mcp.addTileHint')}
                </small>
              </button>
            </div>
          )}

          {ctxMenu && (
            <DropdownMenu
              open
              onOpenChange={(open) => {
                if (!open) setCtxMenu(null)
              }}
            >
              <DropdownMenuTrigger asChild>
                <span
                  className="pointer-events-none fixed"
                  style={{ left: ctxMenu.x, top: ctxMenu.y }}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="bottom"
                align="start"
                className="min-w-[180px]"
              >
                <DropdownMenuItem
                  onSelect={() => {
                    setLogServer(ctxMenu.key)
                    setCtxMenu(null)
                  }}
                >
                  <FileText />
                  {t('mcp-servers:serverLog.title', { serverName: ctxMenu.key })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    handleEdit(ctxMenu.key)
                    setCtxMenu(null)
                  }}
                >
                  <Pencil />
                  {t('mcp-servers:editServer')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const config = mcpServers[ctxMenu.key]
                    if (config) {
                      toggleServer(
                        ctxMenu.key,
                        !snapshotFor(ctxMenu.key, config).snapshot.switchOn
                      )
                    }
                    setCtxMenu(null)
                  }}
                >
                  <Power />
                  {mcpServers[ctxMenu.key] &&
                  snapshotFor(ctxMenu.key, mcpServers[ctxMenu.key]).snapshot
                    .switchOn
                    ? t('mcp-servers:connection.disable')
                    : t('mcp-servers:connection.enable')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    handleDeleteClick(ctxMenu.key)
                    setCtxMenu(null)
                  }}
                >
                  <Trash2 />
                  {t('mcp-servers:deleteServer.title')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
