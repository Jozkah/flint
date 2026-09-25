import { createFileRoute } from '@tanstack/react-router'
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
import { cn } from '@/lib/utils'
import { ApiKeyInput } from '@/containers/ApiKeyInput'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { LogViewer } from '@/components/LogViewer'
import { ensureModelForServer } from '@/utils/ensureModelForServer'

import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  LoaderCircle,
} from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/containers/engine/BrandMark'
import { modelLogo } from '@/lib/brandLogos'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.local_api_server as any)({
  component: LocalAPIServerContent,
})

function LocalAPIServerContent() {
  const { t } = useTranslation()
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
    setServerPort,
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

  const providers = useModelProvider((state) => state.providers)
  const localModels = useMemo(
    () =>
      providers
        .filter((p) => p.provider === 'llamacpp' || p.provider === 'mlx')
        .flatMap((p) => p.models.map((m) => ({ id: m.id, provider: p.provider }))),
    [providers]
  )

  const { serverStatus, setServerStatus } = useAppState()
  const [showApiKeyError, setShowApiKeyError] = useState(false)
  const setActiveModels = useAppState((state) => state.setActiveModels)

  useEffect(() => {
    const checkServerStatus = async () => {
      try {
        const running = await serviceHub.app().getServerStatus()
        console.log('Server status check:', running)
        if (running) {
          setServerStatus('running')
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
      console.log('Starting server with port:', serverPort)
      toast.info('Starting server...', {
        description: `Attempting to start server on port ${serverPort}`,
      })

      // if (!apiKey || apiKey.toString().trim().length === 0) {
      //   setShowApiKeyError(true)
      //   return
      // }

      setShowApiKeyError(false)

      setServerStatus('pending')

      ensureModelForServer({
        modelsService: serviceHub.models(),
        modelOverride: defaultModelLocalApiServer,
        onLoadStart: () => setIsModelLoading(true),
        onLoadEnd: () => setIsModelLoading(false),
      })
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
          return window.core?.api?.startServer({
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
        })
        .then((actualPort: number) => {
          // Store the actual port that was assigned (important for mobile with port 0)
          if (actualPort && actualPort !== serverPort) {
            setServerPort(actualPort)
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

          // Port-related errors (highest priority)
          if (errorMsg.includes('Address already in use')) {
            toast.error(t('model-errors:serverPortOccupied'), {
              description: t('model-errors:serverPortOccupiedDescription', {
                port: serverPort,
              }),
            })
          }
          // Model-related errors
          else if (errorMsg.includes('Invalid or inaccessible model path')) {
            toast.error(t('model-errors:serverInvalidModelPath'), {
              description: errorMsg,
            })
          } else if (errorMsg.includes('model')) {
            toast.error(t('model-errors:serverStartModelFailed'), {
              description: errorMsg,
            })
          }
          // Generic server errors
          else {
            toast.error(t('model-errors:serverStartFailed'), {
              description: errorMsg,
            })
          }
        })
    } else {
      setServerStatus('pending')
      window.core?.api
        ?.stopServer()
        .then(() => {
          setServerStatus('stopped')
        })
        .catch((error: unknown) => {
          console.error('Error stopping server:', error)
          setServerStatus('stopped')
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

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:local_api_server')} />
      <SettingsPageBody
        title={t('common:local_api_server')}
        description={t('settings:pageDesc.localApiServer')}
        actions={
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="pointer-coarse:h-11">
                <Icon name="x-sliders" size={14} />
                Configuration
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[min(100vw-1.5rem,480px)] max-h-[70vh] overflow-y-auto bg-card"
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
                    {t('settings:localApiServer.serverConfiguration')}
                  </h2>
                </div>
                <div className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-medium">
                        {t('settings:localApiServer.serverHost')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings:localApiServer.serverHostDesc')}
                      </p>
                    </div>
                    <div>
                      <ServerHostSwitcher isServerRunning={isServerRunning} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-medium">
                        {t('settings:localApiServer.serverPort')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings:localApiServer.serverPortDesc')}
                      </p>
                    </div>
                    <PortInput isServerRunning={isServerRunning} />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-medium">
                        {t('settings:localApiServer.apiPrefix')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings:localApiServer.apiPrefixDesc')}
                      </p>
                    </div>
                    <ApiPrefixInput isServerRunning={isServerRunning} />
                  </div>
                  <div className="flex flex-col space-y-1">
                    <p className="text-[13px] font-medium">
                      {t('settings:localApiServer.apiKey')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('settings:localApiServer.apiKeyDesc')}
                    </p>
                    <div className="pt-1">
                      <ApiKeyInput
                        isServerRunning={isServerRunning}
                        showError={showApiKeyError}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col space-y-1">
                    <p className="text-[13px] font-medium">
                      {t('settings:localApiServer.trustedHosts')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('settings:localApiServer.trustedHostsDesc')}
                    </p>
                    <div className="pt-1">
                      <TrustedHostsInput isServerRunning={isServerRunning} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-medium">
                        {t('settings:localApiServer.proxyTimeout')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings:localApiServer.proxyTimeoutDesc')}
                      </p>
                    </div>
                    <ProxyTimeoutInput isServerRunning={isServerRunning} />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <h2 className="text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
                    {t('settings:localApiServer.advancedSettings')}
                  </h2>
                </div>
                <div className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-medium">
                        Execute tools on server
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Run tools server-side for chat endpoints.
                      </p>
                    </div>
                    <Switch
                      checked={enableServerToolExecution}
                      onCheckedChange={setEnableServerToolExecution}
                      disabled={isServerRunning}
                    />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-medium">
                        {t('settings:localApiServer.cors')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings:localApiServer.corsDesc')}
                      </p>
                    </div>
                    <Switch
                      checked={corsEnabled}
                      onCheckedChange={setCorsEnabled}
                      disabled={isServerRunning}
                    />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-medium">
                        {t('settings:localApiServer.verboseLogs')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings:localApiServer.verboseLogsDesc')}
                      </p>
                    </div>
                    <Switch
                      checked={verboseLogs}
                      onCheckedChange={setVerboseLogs}
                      disabled={isServerRunning}
                    />
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        }
        layout={[0, 1, 1]}
      >
              {/* General Settings */}
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
                    description={t(
                      'settings:localApiServer.runInBackgroundDesc'
                    )}
                    actions={
                      <Switch
                        checked={runInBackground}
                        onCheckedChange={setRunInBackground}
                      />
                    }
                  />
                )}
                <CardItem
                  title={t('settings:localApiServer.defaultModel')}
                  description={t('settings:localApiServer.defaultModelDesc')}
                  actions={
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="w-full min-w-[220px] justify-between pointer-coarse:h-11 sm:w-auto"
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            {defaultModelLocalApiServer ? (
                              <>
                                <span className="inline-flex h-[18px] shrink-0 items-center rounded-md border-[0.8px] border-border bg-card px-2 text-xs font-medium">
                                  Local
                                </span>
                                <BrandMark
                                  logo={modelLogo(defaultModelLocalApiServer.model)}
                                  name={defaultModelLocalApiServer.model}
                                  size={16}
                                  className="rounded-full"
                                />
                                <span className="min-w-0 flex-1 truncate text-left">
                                  {providers
                                    .find(
                                      (p) =>
                                        p.provider ===
                                        defaultModelLocalApiServer.provider
                                    )
                                    ?.models.find(
                                      (m) =>
                                        m.id === defaultModelLocalApiServer.model
                                    )?.name ?? defaultModelLocalApiServer.model}
                                </span>
                              </>
                            ) : (
                              <span className="truncate">
                                {t(
                                  'settings:localApiServer.defaultModelPlaceholder'
                                )}
                              </span>
                            )}
                          </span>
                          <Icon name="arrow-down" size={12} className="opacity-70" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64 max-h-60 overflow-y-auto">
                        {localModels.map(({ id: modelId, provider }) => (
                          <DropdownMenuItem
                            key={`${provider}/${modelId}`}
                            className={cn(
                              'cursor-pointer my-0.5',
                              defaultModelLocalApiServer?.model === modelId &&
                                defaultModelLocalApiServer?.provider ===
                                  provider &&
                                'bg-accent'
                            )}
                            onClick={() =>
                              setDefaultModelLocalApiServer({
                                model: modelId,
                                provider,
                              })
                            }
                          >
                            <span className="truncate font-mono text-xs">{modelId}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              </Card>

              <Card>
                <CardItem
                  title="Server Status"
                  description={
                    isServerRunning
                      ? 'The server is currently running.'
                      : 'The server is stopped.'
                  }
                  actions={
                    <>
                      <Chip tone={isServerRunning ? 'ok' : 'neutral'} dot live={isServerRunning}>
                        {isServerRunning ? 'Running' : 'Stopped'}
                      </Chip>
                      {isServerRunning && (
                        <code className="inline-flex h-[30px] items-center rounded-lg bg-muted px-2.5 font-mono text-[11.5px] text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
                          http://{serverHost}:{serverPort}
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
                      href={`http://${serverHost}:${serverPort}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        isServerRunning ? '' : 'pointer-events-none'
                      )}
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
              </Card>

              <Card
                title="Server Log"
                aside={
                  <Button
                    variant="outline"
                    onClick={handleOpenLogs}
                    className="pointer-coarse:h-11"
                  >
                    Open in New Window
                  </Button>
                }
              >
                <div className="h-[160px]">
                  <LogViewer />
                </div>
              </Card>
      </SettingsPageBody>
    </div>
  )
}
