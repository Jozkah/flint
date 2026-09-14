import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useClaudeCodeModel } from '@/hooks/useClaudeCodeModel'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import AddEditCustomCliDialog from '@/containers/dialogs/AddEditCustomCliDialog'
import { cn } from '@/lib/utils'
import { useState, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { getModelToStart } from '@/utils/getModelToStart'
import { invoke } from '@tauri-apps/api/core'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { ChevronDown, Plus, X } from 'lucide-react'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import Capabilities from '@/containers/Capabilities'
import { getModelDisplayName, isLocalProvider } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.claude_code as any)({
  component: ClaudeCodeIntegration,
})

function ClaudeCodeIntegration() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const {
    corsEnabled,
    verboseLogs,
    serverHost,
    serverPort,
    setServerPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    proxyTimeout,
    setLastServerModels,
  } = useLocalApiServer()

  const { serverStatus, setServerStatus } = useAppState()
  const { providers, selectedModel, selectedProvider, getProviderByName } =
    useModelProvider()
  const setActiveModels = useAppState((state) => state.setActiveModels)

  const {
    models: helperModels,
    setModel: setHelperModel,
    setEnvVars,
    setCustomCli,
    clearModels,
  } = useClaudeCodeModel()

  const [isCustomCliDialogOpen, setIsCustomCliDialogOpen] = useState(false)
  const [isModelLoading, setIsModelLoading] = useState(false)

  const handleLaunchClaudeCode = async () => {
    const apiUrl = `http://${serverHost}:${serverPort}`
    const modelBig = helperModels.big
    const modelMedium = helperModels.medium
    const modelSmall = helperModels.small
    const customEnvVars = helperModels.envVars

    const startServer = async (): Promise<void> => {
      const helperModelsToStart = [
        { id: helperModels.big, role: 'Big' },
        { id: helperModels.medium, role: 'Medium' },
        { id: helperModels.small, role: 'Small' },
      ]
        .filter((m) => m.id)
        .map((m) => m.id as string)

      const loadedModels = (await serviceHub.models().getActiveModels()) || []
      const modelsToStart = helperModelsToStart.filter(
        (m) => !loadedModels.includes(m)
      )

      if (modelsToStart.length > 0) {
        setIsModelLoading(true)
        for (const modelId of modelsToStart) {
          const providerWithModel = providers.find((p) =>
            p.models.some((m) => m.id === modelId)
          )

          if (providerWithModel) {
            await serviceHub
              .models()
              .startModel(providerWithModel, modelId, true)
              .then(() => {
                console.log(`Model ${modelId} started successfully`)
              })
          }
        }
        setIsModelLoading(false)
        await serviceHub
          .models()
          .getActiveModels()
          .then((models) => setActiveModels(models || []))
        await new Promise((resolve) => setTimeout(resolve, 500))
      } else if (loadedModels.length > 0) {
        console.log(`Using already loaded models: ${loadedModels.join(', ')}`)
      } else if (helperModelsToStart.length === 0) {
        const modelToStart = getModelToStart({
          selectedModel,
          selectedProvider,
          getProviderByName,
        })

        if (modelToStart) {
          setIsModelLoading(true)
          await serviceHub
            .models()
            .startModel(modelToStart.provider, modelToStart.model, true)
            .then(() => {
              console.log(`Model ${modelToStart.model} started successfully`)
              setIsModelLoading(false)
              serviceHub
                .models()
                .getActiveModels()
                .then((models) => setActiveModels(models || []))
              return new Promise((resolve) => setTimeout(resolve, 500))
            })
        }
      }

      let actualPort: number | undefined
      try {
        actualPort = await window.core?.api?.startServer({
          host: serverHost,
          port: serverPort,
          prefix: apiPrefix,
          apiKey,
          trustedHosts,
          isCorsEnabled: corsEnabled,
          isVerboseEnabled: verboseLogs,
          proxyTimeout: proxyTimeout,
        })
      } catch (startErr) {
        const msg =
          startErr instanceof Error ? startErr.message : String(startErr)
        if (!msg.includes('already running')) throw startErr
      }

      if (actualPort && actualPort !== serverPort) {
        setServerPort(actualPort)
      }
      setServerStatus('running')

      // Persist whichever models are actually running so next startup can restore them
      const activeModels = await serviceHub.models().getActiveModels().catch(() => [] as string[])
      if (activeModels.length > 0) {
        const serverModels = activeModels.flatMap((id) => {
          const p = providers.find((p) => p?.models?.some((m) => m.id === id))
          return p ? [{ model: id, provider: p.provider }] : []
        })
        if (serverModels.length > 0) setLastServerModels(serverModels)
      }
    }

    try {
      if (serverStatus === 'stopped') {
        toast.info('Starting server...', {
          description: 'Preparing server for Claude Code',
        })
        try {
          await startServer()
        } catch (startErr) {
          // A bind/start failure (e.g. Windows error 10048, address already in
          // use) is a server-start problem, not an env-var problem. Name it
          // clearly and abort instead of mislabeling it below. The 'already
          // running' case is already swallowed inside startServer and proceeds.
          const msg =
            startErr instanceof Error ? startErr.message : String(startErr)
          toast.error('Failed to start the local API server', {
            description: msg,
          })
          return
        }
      }
      await invoke('launch_claude_code_with_config', {
        apiUrl,
        apiKey: apiKey || undefined,
        bigModel: modelBig || undefined,
        mediumModel: modelMedium || undefined,
        smallModel: modelSmall || undefined,
        customEnvVars: customEnvVars.map((env) => ({
          key: env.key,
          value: env.value,
        })),
      })
      toast.success(
        'Environment variables updated. Please try relaunching Claude Code in a new terminal window.',
        {
          duration: 8000,
        }
      )
    } catch (error) {
      console.error('Failed to launch Claude Code:', error)
      const errorMsg = error instanceof Error ? error.message : String(error)
      toast.error('Failed to configure env vars', {
        description: errorMsg,
      })
    }
  }

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader />
      <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0">
        <div className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-6">
          <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
            <Card
              header={
                <div className="mb-4 flex w-full items-center gap-3">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 99 72"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="shrink-0"
                  >
                    <path d="M9 0H90V54H9V0Z" fill="#D77757" />
                    <path d="M0 18H9V36H0V18Z" fill="#D77757" />
                    <path d="M18 18H27V27H18V18Z" fill="black" />
                    <path d="M72 18H81V27H72V18Z" fill="black" />
                    <path d="M90 18H99V36H90V18Z" fill="#D77757" />
                    <path d="M9 54H18V72H9V54Z" fill="#D77757" />
                    <path d="M63 54H72V72H63V54Z" fill="#D77757" />
                    <path d="M27 54H36V72H27V54Z" fill="#D77757" />
                    <path d="M81 54H90V72H81V54Z" fill="#D77757" />
                  </svg>
                  <h1 className=" text-xl font-semibold text-foreground">
                    Claude Code integration
                  </h1>
                </div>
              }
            >
              <CardItem
                anchor="settings-claude-code-large-model"
                title={t('settings:claudeCode.largeModel')}
                description={t('settings:claudeCode.largeModelDesc')}
                actions={
                  <HelperModelSelector
                    providers={providers}
                    selectedModel={helperModels.big}
                    onSelect={(model) => setHelperModel('big', model)}
                    placeholder="Select Big Model"
                  />
                }
              />
              <CardItem
                anchor="settings-claude-code-medium-model"
                title={t('settings:claudeCode.mediumModel')}
                description={t('settings:claudeCode.mediumModelDesc')}
                actions={
                  <HelperModelSelector
                    providers={providers}
                    selectedModel={helperModels.medium}
                    onSelect={(model) => setHelperModel('medium', model)}
                    placeholder="Select Medium Model"
                  />
                }
              />
              <CardItem
                anchor="settings-claude-code-small-model"
                title={t('settings:claudeCode.smallModel')}
                description={t('settings:claudeCode.smallModelDesc')}
                actions={
                  <HelperModelSelector
                    providers={providers}
                    selectedModel={helperModels.small}
                    onSelect={(model) => setHelperModel('small', model)}
                    placeholder="Select Small Model"
                  />
                }
              />

              <div className="mt-4 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
                <Button
                  size="sm"
                  variant="outline"
                  className="pointer-coarse:h-11"
                  onClick={() => setIsCustomCliDialogOpen(true)}
                >
                  <Plus className="text-muted-foreground" aria-hidden />
                  Environment Variables
                </Button>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="pointer-coarse:h-11"
                    onClick={async () => {
                      clearModels()
                      try {
                        await invoke('clear_claude_code_env')
                        toast.success('Claude Code settings cleared')
                      } catch (e) {
                        toast.error(`Failed to clear env file: ${e}`)
                      }
                    }}
                  >
                    Reset
                  </Button>
                  <Button
                    size="sm"
                    className="pointer-coarse:h-11"
                    onClick={handleLaunchClaudeCode}
                    disabled={isModelLoading}
                  >
                    {isModelLoading ? 'Loading models...' : 'Save & Enable'}
                  </Button>
                </div>
              </div>

              {(helperModels.customCli || helperModels.envVars.length > 0) && (
                <div className="mt-3 space-y-1 rounded-md bg-sunken px-3 py-2 text-sm text-ink-2">
                  {helperModels.customCli && (
                    <div className="break-all">
                      Command:{' '}
                      <span className="font-mono">{helperModels.customCli}</span>
                    </div>
                  )}
                  {helperModels.envVars.length > 0 && (
                    <div className="break-all">
                      Env:{' '}
                      {helperModels.envVars
                        .map((env) => `${env.key}=******`)
                        .join(', ')}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
      <AddEditCustomCliDialog
        open={isCustomCliDialogOpen}
        onOpenChange={setIsCustomCliDialogOpen}
        initialEnvVars={helperModels.envVars}
        initialCustomCli={helperModels.customCli}
        onSave={(envVars, customCli) => {
          setEnvVars(envVars)
          setCustomCli(customCli)
        }}
      />
    </div>
  )
}

function HelperModelSelector({
  providers,
  selectedModel,
  onSelect,
  placeholder = 'Select a model',
}: {
  providers: ModelProvider[]
  selectedModel: string | null
  onSelect: (modelId: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const availableModels = useMemo(() => {
    return providers
      .filter((p) => p.active)
      .flatMap((p) =>
        p.models.map((m) => ({
          ...m,
          providerName: p.provider,
          isLocal: isLocalProvider(p.provider),
          hasApiKey: !!p.api_key?.length,
        }))
      )
      .filter((m) => {
        if (m.isLocal) {
          return m.id
        }
        return m.hasApiKey
      })
  }, [providers])

  const filteredModels = useMemo(() => {
    if (!searchValue.trim()) return availableModels
    const search = searchValue.toLowerCase()
    return availableModels.filter(
      (m) =>
        m.id.toLowerCase().includes(search) ||
        (m.displayName?.toLowerCase() ?? '').includes(search) ||
        m.providerName.toLowerCase().includes(search)
    )
  }, [availableModels, searchValue])

  const groupedModels = useMemo(() => {
    const groups: Record<string, typeof filteredModels> = {}
    filteredModels.forEach((model) => {
      if (!groups[model.providerName]) {
        groups[model.providerName] = []
      }
      groups[model.providerName].push(model)
    })
    return groups
  }, [filteredModels])

  const currentModel = availableModels.find((m) => m.id === selectedModel)

  const formatModelWithSize = (model: NonNullable<typeof currentModel>) => {
    const name = getModelDisplayName(model)
    return name
  }

  const handleSelect = (model: (typeof filteredModels)[0]) => {
    onSelect(model.id)
    setOpen(false)
    setSearchValue('')
  }

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    if (!isOpen) {
      setSearchValue('')
    } else {
      setTimeout(() => searchInputRef.current?.focus(), 100)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-[min(100%,280px)] pointer-coarse:h-11"
        >
          <span className="flex items-center gap-2 truncate leading-normal">
            {selectedModel && currentModel ? (
              <>
                <span
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full shrink-0',
                    currentModel.isLocal
                      ? 'bg-success-tint text-success'
                      : 'bg-sunken text-ink-2'
                  )}
                >
                  {currentModel.isLocal ? 'Local' : 'Remote'}
                </span>
                <span>{formatModelWithSize(currentModel)}</span>
              </>
            ) : (
              placeholder
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[min(100vw-2rem,280px)] border border-border bg-popover p-0"
        align="end"
        sideOffset={8}
      >
        <div className="flex flex-col size-full">
          <div className="relative border-b border-border p-2">
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="Search models..."
              className="w-full bg-transparent pr-8 text-base font-normal outline-0 md:text-sm"
            />
            {searchValue.length > 0 && (
              <div className="absolute right-2 top-0 bottom-0 flex items-center justify-center">
                <X
                  size={16}
                  className="text-muted-foreground cursor-pointer"
                  onClick={() => setSearchValue('')}
                />
              </div>
            )}
          </div>

          <div className="max-h-[300px] overflow-y-auto">
            {Object.keys(groupedModels).length === 0 && searchValue ? (
              <div className="py-3 px-4 text-sm text-muted-foreground">
                No models found for &quot;{searchValue}&quot;
              </div>
            ) : (
              <div className="py-1">
                {Object.entries(groupedModels).map(([providerKey, models]) => {
                  const providerInfo = providers.find(
                    (p) => p.provider === providerKey
                  )
                  if (!providerInfo) return null

                  return (
                    <div
                      key={providerKey}
                      className="mx-1.5 my-1.5 rounded-md bg-sunken/50 py-1 first:mt-1"
                    >
                      <div className="flex items-center gap-1.5 px-2 py-1">
                        <ProvidersAvatar provider={providerInfo} />
                        <span className="capitalize text-sm font-medium text-muted-foreground">
                          {providerKey}
                        </span>
                      </div>

                      {models.map((model) => {
                        const isSelected = selectedModel === model.id
                        const capabilities = model.capabilities || []

                        return (
                          <div
                            key={model.id}
                            title={model.id}
                            onClick={() => handleSelect(model)}
                            className={cn(
                              'mx-1 mb-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors pointer-coarse:min-h-11',
                              'hover:bg-card',
                              isSelected &&
                                'bg-brand-tint shadow-[inset_2px_0_0_var(--brand)] hover:bg-brand-tint'
                            )}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span
                                className="text-sm truncate"
                                title={model.id}
                              >
                                {getModelDisplayName(model)}
                              </span>
                              <div className="flex-1"></div>
                              {capabilities.length > 0 && (
                                <div className="shrink-0 -mr-1.5">
                                  <Capabilities capabilities={capabilities} />
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

