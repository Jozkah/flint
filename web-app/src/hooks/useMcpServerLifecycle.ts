import type { MCPServerStatus } from '@/services/mcp/types'
import { useMCPServers, MCPServerConfig } from '@/hooks/useMCPServers'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { resolveServerFingerprints } from '@/lib/mcpServerIdentity'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { listen } from '@tauri-apps/api/event'
import { SystemEvent } from '@/types/events'
import { normalizeAppError } from '@/utils/appError'
import { useMcpAuth } from '@/hooks/useMcpAuth'
import { activationConfirmed, activationFailed, beginActivation, classifyActivationFailure, runtimeCleared, type McpServerRuntime } from '@/lib/mcpConnectionState'
import { transportOf } from '@/lib/mcpServerProfile'

type Servers = ReturnType<typeof useMCPServers.getState>
type Auth = ReturnType<typeof useMcpAuth>

/**
 * The MCP servers page's live state and the actions that change it: which
 * servers are connected, their on-demand lifecycle, the in-flight activation
 * of each, their security fingerprints, and start / stop / sign-in / toggle.
 * Moved out of the page unchanged; the activation state machine keeps its
 * await and set-state ordering.
 */
export function useMcpServerLifecycle({
  mcpServers,
  editServer,
  syncServers,
  getServerConfig,
  authorize,
  clearAuth,
  refreshAuth,
  setErrorMessage,
}: {
  mcpServers: Servers['mcpServers']
  editServer: Servers['editServer']
  syncServers: Servers['syncServers']
  getServerConfig: Servers['getServerConfig']
  authorize: Auth['authorize']
  clearAuth: Auth['clearAuth']
  refreshAuth: Auth['refresh']
  setErrorMessage: ReturnType<typeof useAppState.getState>['setErrorMessage']
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [connectedServers, setConnectedServers] = useState<string[]>([])
  const [loadingServers, setLoadingServers] = useState<{
    [key: string]: boolean
  }>({})

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
  // Serialized once per store update, not on every render.
  const serversSignature = useMemo(() => JSON.stringify(mcpServers), [mcpServers])
  useEffect(() => {
    void refreshFingerprints()
  }, [serversSignature, refreshFingerprints])

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

  // Per-server tool call timeout; empty falls back to the global setting.
  const setServerToolTimeout = async (
    serverKey: string,
    config: MCPServerConfig,
    seconds: number | undefined
  ) => {
    const next = { ...config }
    if (seconds !== undefined) {
      next.toolCallTimeoutSeconds = seconds
    } else {
      delete next.toolCallTimeoutSeconds
    }
    editServer(serverKey, next)
    syncServers()
    if (config.active) {
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
  ): Promise<void> => {
    if (serverKey) {
      setLoadingServers((prev) => ({ ...prev, [serverKey]: true }))
      // React state updates asynchronously; save can activate a server before
      // its new config appears in mcpServers.
      const config = configOverride ?? getServerConfig(serverKey)
      if (active && config) {
        const transport = transportOf(config)
        setRuntime((prev) => ({ ...prev, [serverKey]: beginActivation() }))
        let started = false
        return serviceHub
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
        return serviceHub
          .mcp()
          .deactivateMCPServer(serverKey)
          .catch((error) => {
            console.error('Error deactivating server:', error)
          })
          .finally(() => {
            refreshConnectedServers()
            setLoadingServers((prev) => ({ ...prev, [serverKey]: false }))
          })
      }
    }
    return Promise.resolve()
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

  return {
    connectedServers,
    loadingServers,
    lifecycle,
    runtime,
    setRuntime,
    fingerprints,
    refreshConnectedServers,
    refreshFingerprints,
    toggleServer,
    handleAuthorize,
    handleClearAuth,
    startNow,
    stopNow,
    setStartWithFlint,
    setServerToolTimeout,
  }
}
