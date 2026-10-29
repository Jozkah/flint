import { createFileRoute } from '@tanstack/react-router'
import { desktopOnlyRoute } from '@/lib/desktopOnlyRoute'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Chip } from '@/components/ui/chip'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ServerHostSwitcher } from '@/containers/ServerHostSwitcher'
import { PortInput } from '@/containers/PortInput'
import { ProxyTimeoutInput } from '@/containers/ProxyTimeoutInput'
import { ApiPrefixInput } from '@/containers/ApiPrefixInput'
import { TrustedHostsInput } from '@/containers/TrustedHostsInput'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  cn,
  guardServerStart,
  MODEL_LOAD_WATCHDOG_MS,
  withTimeout,
} from '@/lib/utils'
import { ApiKeyInput } from '@/containers/ApiKeyInput'
import { LocalModelSelect } from '@/containers/LocalModelSelect'
import { UsageCeilingsCard } from '@/containers/UsageCeilingsCard'
import { UsageAttributionCard } from '@/containers/UsageAttributionCard'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { LogViewer } from '@/components/LogViewer'
import { ensureModelForServer } from '@/utils/ensureModelForServer'
import {
  SettingsTabStrip,
  useSettingsTab,
  type SettingsTab,
} from '@/containers/SettingsTabs'
import { LoaderCircle } from 'lucide-react'
import { claudeCodeApiUrl } from '@/lib/claudeCodeLaunch'


export const Route = createFileRoute(route.settings.local_api_server)({
  component: desktopOnlyRoute(LocalAPIServerContent, 'common:local_api_server'),
})

type ServerTab = 'server' | 'settings'

function LocalAPIServerContent() {
  const { t } = useTranslation()
  const tabs: SettingsTab<ServerTab>[] = [
    {
      id: 'server',
      label: t('permissions:request.server'),
      anchors: [
        'settings-local-api-server-run-on-startup',
        'settings-local-api-server-default-model',
      ],
    },
    {
      id: 'settings',
      label: t('common:settings'),
      anchors: [
        'settings-local-api-server-host',
        'settings-local-api-server-port',
        'settings-local-api-server-api-prefix',
        'settings-local-api-server-api-key',
        'settings-local-api-server-trusted-hosts',
        'settings-local-api-server-request-timeout',
        'settings-local-api-server-server-tools',
        'settings-local-api-server-cors',
        'settings-local-api-server-verbose-logs',
      ],
    },
  ]
  const [tab, setTab] = useSettingsTab(tabs)
  const serviceHub = useServiceHub()
  const {
    corsEnabled,
    setCorsEnabled,
    verboseLogs,
    setVerboseLogs,
    enableOnStartup,
    setEnableOnStartup,
    runInBackground,
    setRunInBackground,
    serverHost,
    serverPort,
    activeServerPort,
    setActiveServerPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    proxyTimeout,
    enableServerToolExecution,
    setEnableServerToolExecution,
    setLastServerModels,
    defaultModelLocalApiServer,
    setDefaultModelLocalApiServer,
  } = useLocalApiServer()

  const serverStatus = useAppState((state) => state.serverStatus)
  const setServerStatus = useAppState((state) => state.setServerStatus)
  const [showApiKeyError, setShowApiKeyError] = useState(false)
  const setActiveModels = useAppState((state) => state.setActiveModels)

  // The error describes the host/key pair, so drop it once either changes.
  useEffect(() => {
    setShowApiKeyError(false)
  }, [serverHost, apiKey])

  useEffect(() => {
    const checkServerStatus = async () => {
      try {
        const running = await serviceHub.app().getServerStatus()
        console.log('Server status check:', running)
        if (useAppState.getState().serverStatus !== 'pending') {
          setServerStatus(running ? 'running' : 'stopped')
        }
      } catch (error) {
        console.error('Failed to check server status:', error)
      }
    }
    checkServerStatus()

    // Also check when window gains focus (e.g., server started from another page)
    const handleFocus = () => checkServerStatus()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [serviceHub, setServerStatus])

  const [isModelLoading, setIsModelLoading] = useState(false)

  const toggleAPIServer = async () => {
    // Validate API key before starting server
    if (serverStatus === 'stopped') {
      // Reachable from the whole network with no key is an open proxy to the
      // user's models and tools. Loopback without a key stays allowed.
      if (serverHost === '0.0.0.0' && !String(apiKey ?? '').trim()) {
        setShowApiKeyError(true)
        toast.error(
          t('settings:localApiServer.apiKeyRequiredLan', {
            defaultValue:
              'Set an API key before exposing the server on 0.0.0.0, or switch the host to 127.0.0.1.',
          })
        )
        return
      }

      console.log('Starting server with port:', serverPort)
      toast.info(t('uiLeftovers:localApi.starting'), {
        description: t('uiLeftovers:localApi.startingDesc', {
          port: serverPort,
        }),
      })

      setShowApiKeyError(false)

      setServerStatus('pending')

      // Which step failed decides the toast: anything before the server call
      // is the model step, the server call answers with a stable code.
      let phase: 'model' | 'server' = 'model'

      withTimeout(
        ensureModelForServer({
          modelsService: serviceHub.models(),
          modelOverride: defaultModelLocalApiServer,
          onLoadStart: () => setIsModelLoading(true),
          onLoadEnd: () => setIsModelLoading(false),
        }),
        MODEL_LOAD_WATCHDOG_MS,
        'Timed out waiting for the model to finish loading.'
      )
        .then(async (result) => {
          if (result.status === 'no_model_available') {
            throw new Error('No model available to load')
          }

          // Remember loaded models for next startup
          const activeModels = await serviceHub.models().getActiveModels()
          if (activeModels && activeModels.length > 0) {
            const allProviders = useModelProvider.getState().providers
            const serverModels = activeModels.flatMap((id: string) => {
              const p = allProviders.find((p) =>
                p?.models?.some((m: { id: string }) => m.id === id)
              )
              return p ? [{ model: id, provider: p.provider }] : []
            })
            if (serverModels.length > 0) setLastServerModels(serverModels)
          }

          // Refresh active models in app state
          const models = await serviceHub.models().getActiveModels()
          setActiveModels(models || [])
        })
        .then(() => {
          // Then start the server
          phase = 'server'
          return guardServerStart(
            window.core?.api?.startServer({
              host: serverHost,
              port: serverPort,
              prefix: apiPrefix,
              apiKey,
              trustedHosts,
              isCorsEnabled: corsEnabled,
              isVerboseEnabled: verboseLogs,
              proxyTimeout: proxyTimeout,
              enableServerToolExecution,
            })
          )
        })
        .then((actualPort: number | undefined) => {
          // Track the port actually bound (important for mobile with port 0).
          // The configured port stays as the user set it.
          if (actualPort) setActiveServerPort(actualPort)
          if (actualPort && actualPort !== serverPort) {
            // The backend falls back to a free port when the configured one
            // is taken or refused; say so rather than silently changing it.
            toast.warning(t('model-errors:serverPortFallback'), {
              description: t('model-errors:serverPortFallbackDescription', {
                requested: serverPort,
                actual: actualPort,
              }),
            })
          }
          setServerStatus('running')
        })
        .catch((error: unknown) => {
          console.error('Error starting server or model:', error)
          setServerStatus('stopped')
          setIsModelLoading(false) // Reset loading state on error
          toast.dismiss()

          // Extract error message from various error formats
          const errorMsg =
            error && typeof error === 'object' && 'message' in error
              ? String(error.message)
              : String(error)

          // `start_server` rejects with { code, message } (ServerStartError).
          const code =
            error && typeof error === 'object' && 'code' in error
              ? String((error as { code: unknown }).code)
              : undefined

          if (phase === 'server' && code === 'PORT_IN_USE') {
            toast.error(t('model-errors:serverPortOccupied'), {
              description: t('model-errors:serverPortOccupiedDescription', {
                port: serverPort,
              }),
            })
          } else if (phase === 'model') {
            toast.error(t('model-errors:serverStartModelFailed'), {
              description: errorMsg,
            })
          } else {
            toast.error(t('model-errors:serverStartFailed'), {
              description: errorMsg,
            })
          }
        })
    } else {
      const previousStatus = serverStatus
      setServerStatus('pending')
      const stop = window.core?.api?.stopServer()
      if (!stop) {
        // Nothing to stop it with: do not leave the button stuck on pending.
        setServerStatus(previousStatus)
        return
      }
      stop
        .then(() => {
          setServerStatus('stopped')
        })
        .catch(async (error: unknown) => {
          console.error('Error stopping server:', error)
          // The stop failed, so the server may still be up: ask, do not assume.
          let running = true
          try {
            running = await serviceHub.app().getServerStatus()
          } catch {
            // keep "running": a failed probe is not proof it stopped
          }
          setServerStatus(running ? 'running' : 'stopped')
          toast.error(t('model-errors:serverStartFailed'), {
            description: String((error as { message?: string })?.message ?? error),
          })
        })
    }
  }

  const getButtonContent = () => {
    if (isModelLoading || serverStatus === 'pending') {
      return (
        <>
          <LoaderCircle className="animate-spin" aria-hidden />
          {isModelLoading
            ? t('settings:localApiServer.loadingModel')
            : t('settings:localApiServer.startingServer')}
        </>
      )
    }
    return isServerRunning
      ? t('settings:localApiServer.stopServer')
      : t('settings:localApiServer.startServer')
  }

  const handleOpenLogs = async () => {
    try {
      await serviceHub.window().openLocalApiServerLogsWindow()
    } catch (error) {
      console.error('Failed to open logs window:', error)
    }
  }

  const isServerRunning = serverStatus !== 'stopped'
  // Bound to 0.0.0.0 the server is reachable on loopback; 0.0.0.0 itself is
  // not an address a browser can open on Windows.
  const serverUrl = claudeCodeApiUrl(serverHost, activeServerPort ?? serverPort)

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:local_api_server')} />
      <SettingsPageBody
        title={t('common:local_api_server')}
        description={t('settings:pageDesc.localApiServer')}
        actions={
          <SettingsTabStrip
            tabs={tabs}
            value={tab}
            onChange={setTab}
            label={t('common:local_api_server')}
          />
        }
        // One entry per slot below, shown or not: Server, Token limits and
        // Server log on the Server tab; Connection and Behaviour on Settings.
        layout={[0, 1, 1, 0, 1]}
      >
        {tab === 'server' && (
          <Card
            title={t('settings:localApiServer.title')}
            description={t('settings:localApiServer.description')}
            aside={
              <Button
                onClick={toggleAPIServer}
                variant={isServerRunning ? 'destructive' : 'default'}
                className="pointer-coarse:h-11"
                disabled={serverStatus === 'pending' || isModelLoading}
              >
                {getButtonContent()}
              </Button>
            }
          >
            <CardItem
              title={t('uiLeftovers:localApi.status')}
              description={
                isServerRunning
                  ? t('uiLeftovers:localApi.runningDesc')
                  : t('uiLeftovers:localApi.stoppedDesc')
              }
              actions={
                <>
                  <Chip
                    tone={isServerRunning ? 'ok' : 'neutral'}
                    dot
                    live={isServerRunning}
                  >
                    {isServerRunning
                      ? t('uiLeftovers:localApi.running')
                      : t('uiLeftovers:localApi.stopped')}
                  </Chip>
                  {isServerRunning && (
                    <code className="inline-flex h-[30px] items-center rounded-lg bg-muted px-2.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)] text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
                      {serverUrl}
                      {apiPrefix}
                    </code>
                  )}
                </>
              }
            />
            <CardItem
              title={t('settings:localApiServer.swaggerDocs')}
              description={t('settings:localApiServer.swaggerDocsDesc')}
              actions={
                <a
                  href={serverUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(isServerRunning ? '' : 'pointer-events-none')}
                >
                  <Button
                    variant="outline"
                    disabled={!isServerRunning}
                    title={t('settings:localApiServer.swaggerDocs')}
                  >
                    <span>{t('settings:localApiServer.openDocs')}</span>
                  </Button>
                </a>
              }
            />
            <CardItem
              anchor="settings-local-api-server-run-on-startup"
              title={t('settings:localApiServer.runOnStartup')}
              description={t('settings:localApiServer.runOnStartupDesc')}
              actions={
                <Switch
                  checked={enableOnStartup}
                  onCheckedChange={(checked) => {
                    setEnableOnStartup(checked)
                  }}
                />
              }
            />
            {!IS_MACOS && (
              <CardItem
                title={t('settings:localApiServer.runInBackground')}
                description={t('settings:localApiServer.runInBackgroundDesc')}
                actions={
                  <Switch
                    checked={runInBackground}
                    onCheckedChange={setRunInBackground}
                  />
                }
              />
            )}
            <CardItem
              anchor="settings-local-api-server-default-model"
              title={t('settings:localApiServer.defaultModel')}
              description={t('settings:localApiServer.defaultModelDesc')}
              actions={
                <div className="w-full min-w-0 sm:w-64 sm:max-w-full">
                  <LocalModelSelect
                    value={defaultModelLocalApiServer}
                    onChange={setDefaultModelLocalApiServer}
                  />
                </div>
              }
            />
          </Card>
        )}

        {tab === 'server' && <UsageCeilingsCard />}

        {tab === 'server' && <UsageAttributionCard />}

        {tab === 'server' && (
          <Card
            title={t('settings:localApiServer.serverLog')}
            aside={
              <Button
                variant="outline"
                onClick={handleOpenLogs}
                className="pointer-coarse:h-11"
              >
                {t('settings:localApiServer.openInNewWindow')}
              </Button>
            }
          >
            <div className="h-[160px]">
              <LogViewer />
            </div>
          </Card>
        )}

        {/* Read when the server starts, so every field locks while it runs. */}
        {tab === 'settings' && (
          <Card title={t('engine:provider.connection')}>
            <CardItem
              anchor="settings-local-api-server-host"
              title={t('settings:localApiServer.serverHost')}
              description={t('settings:localApiServer.serverHostDesc')}
              actions={<ServerHostSwitcher isServerRunning={isServerRunning} />}
            />
            {serverHost === '0.0.0.0' && (
              <p role="note" className="py-2 text-xs text-warning">
                {t('settings:localApiServer.serverHostLanWarning')}
                {trustedHosts.length === 0 && (
                  <> {t('settings:localApiServer.serverHostLanNoTrusted')}</>
                )}
              </p>
            )}
            <CardItem
              anchor="settings-local-api-server-port"
              title={t('settings:localApiServer.serverPort')}
              description={t('settings:localApiServer.serverPortDesc')}
              actions={<PortInput isServerRunning={isServerRunning} />}
            />
            <CardItem
              anchor="settings-local-api-server-api-prefix"
              title={t('settings:localApiServer.apiPrefix')}
              description={t('settings:localApiServer.apiPrefixDesc')}
              actions={<ApiPrefixInput isServerRunning={isServerRunning} />}
            />
            <CardItem
              anchor="settings-local-api-server-api-key"
              column
              title={t('settings:localApiServer.apiKey')}
              description={t('settings:localApiServer.apiKeyDesc')}
              actions={
                <ApiKeyInput
                  isServerRunning={isServerRunning}
                  showError={showApiKeyError}
                />
              }
            />
            <CardItem
              anchor="settings-local-api-server-trusted-hosts"
              column
              title={t('settings:localApiServer.trustedHosts')}
              description={t('settings:localApiServer.trustedHostsDesc')}
              actions={<TrustedHostsInput isServerRunning={isServerRunning} />}
            />
            <CardItem
              anchor="settings-local-api-server-request-timeout"
              title={t('settings:localApiServer.proxyTimeout')}
              description={t('settings:localApiServer.proxyTimeoutDesc')}
              actions={<ProxyTimeoutInput isServerRunning={isServerRunning} />}
            />
          </Card>
        )}

        {tab === 'settings' && (
          <Card title={t('settings:agentTools.tabBehaviour')}>
            <CardItem
              anchor="settings-local-api-server-server-tools"
              title={t('settings:localApiServer.serverTools')}
              description={t('settings:localApiServer.serverToolsDesc')}
              actions={
                <Switch
                  checked={enableServerToolExecution}
                  onCheckedChange={setEnableServerToolExecution}
                  disabled={isServerRunning}
                />
              }
            />
            <CardItem
              anchor="settings-local-api-server-cors"
              title={t('settings:localApiServer.cors')}
              description={t('settings:localApiServer.corsDesc')}
              actions={
                <Switch
                  checked={corsEnabled}
                  onCheckedChange={setCorsEnabled}
                  disabled={isServerRunning}
                />
              }
            />
            <CardItem
              anchor="settings-local-api-server-verbose-logs"
              title={t('settings:localApiServer.verboseLogs')}
              description={t('settings:localApiServer.verboseLogsDesc')}
              actions={
                <Switch
                  checked={verboseLogs}
                  onCheckedChange={setVerboseLogs}
                  disabled={isServerRunning}
                />
              }
            />
          </Card>
        )}
      </SettingsPageBody>
    </div>
  )
}
