import { Card, CardItem } from '@/containers/Card'
import { invokeCommand } from '@/lib/backend'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useClaudeCodeModel } from '@/hooks/useClaudeCodeModel'
import { availableHelperModels, claudeCodeApiUrl } from '@/lib/claudeCodeLaunch'
import { useClaudeCodeContextPlans } from '@/hooks/useClaudeCodeContext'
import { CLAUDE_CODE_MIN_CONTEXT } from '@/lib/claudeCodeContext'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import AddEditCustomCliDialog from '@/containers/dialogs/AddEditCustomCliDialog'
import { cn } from '@/lib/utils'
import { useState, useMemo, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { getModelToStart } from '@/utils/getModelToStart'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { X } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/containers/engine/BrandMark'
import { modelLogo } from '@/lib/brandLogos'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import Capabilities from '@/containers/Capabilities'
import {
  getModelDisplayName,
  guardServerStart,
  isLocalProvider,
} from '@/lib/utils'
import { useHideUnavailable } from '@/hooks/useProviderUnavailable'
import { ModelFilterButton } from '@/containers/ModelFilterButton'

type ClaudeCodeOverride = {
  kind: 'model' | 'env' | 'apiKeyHelper'
  key: string
  value: string | null
  file: string
}

/** The Claude Code tab of Settings > Integrations: the helper models it is
 * launched with, and the overrides in the user's own config. */
export function ClaudeCodeSettings() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const {
    corsEnabled,
    verboseLogs,
    serverHost,
    serverPort,
    activeServerPort,
    setActiveServerPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    proxyTimeout,
    setLastServerModels,
    enableServerToolExecution,
  } = useLocalApiServer()

  const serverStatus = useAppState((state) => state.serverStatus)
  const setServerStatus = useAppState((state) => state.setServerStatus)
  const {
    providers,
    selectedModel,
    selectedProvider,
    getProviderByName,
    updateProvider,
  } = useModelProvider()
  const [overrides, setOverrides] = useState<ClaudeCodeOverride[]>([])

  // Settings in the user's own Claude Code config that win over what is
  // exported here (janhq/jan issue 8107). Read-only.
  useEffect(() => {
    invokeCommand<ClaudeCodeOverride[]>('detect_claude_code_overrides')
      .then((found) => setOverrides(Array.isArray(found) ? found : []))
      .catch(() => setOverrides([]))
  }, [])
  const setActiveModels = useAppState((state) => state.setActiveModels)

  const {
    models: helperModels,
    setModel: setHelperModel,
    setEnvVars,
    setCustomCli,
    clearModels,
  } = useClaudeCodeModel()

  const contextPlans = useClaudeCodeContextPlans([
    helperModels.fable,
    helperModels.big,
    helperModels.medium,
    helperModels.small,
  ])
  const contextWarnings = Object.entries(contextPlans).flatMap(([id, plan]) => {
    if (!plan.shortfall) return []
    const model = providers.flatMap((p) => p.models).find((m) => m.id === id)
    return [
      {
        id,
        text: t(
          `settings:claudeCode.contextShortfall.${plan.shortfall.reason}`,
          {
            model: model ? getModelDisplayName(model) : id,
            context: plan.shortfall.context.toLocaleString(),
            needed: CLAUDE_CODE_MIN_CONTEXT.toLocaleString(),
          }
        ),
      },
    ]
  })

  const [isCustomCliDialogOpen, setIsCustomCliDialogOpen] = useState(false)
  const [isModelLoading, setIsModelLoading] = useState(false)

  const handleLaunchClaudeCode = async () => {
    // Only models the selectors still show: a deleted or switched-off one
    // would otherwise be exported though the page lists the tier as empty.
    const chosen = availableHelperModels(
      helperModels,
      providers,
      (name) => !!isLocalProvider(name)
    )
    const modelFable = chosen.fable
    const modelBig = chosen.big
    const modelMedium = chosen.medium
    const modelSmall = chosen.small
    const customEnvVars = helperModels.envVars
    // The port the server actually bound, which is not serverPort when that one
    // was taken.
    let boundPort = activeServerPort ?? serverPort

    // Claude Code's first request is far larger than the default 8192-token
    // context (janhq/jan#8108). Raise the context of each local model that has
    // not been given one by the user, through the same write-and-reload path the
    // "Increase Context Size" button uses.
    const llamacpp = getProviderByName('llamacpp')
    for (const [id, plan] of Object.entries(contextPlans)) {
      if (plan.raiseTo == null || !llamacpp) continue
      try {
        const latest = getProviderByName('llamacpp') ?? llamacpp
        const index = latest.models.findIndex((m) => m.id === id)
        if (index === -1) continue
        const model = latest.models[index]
        const models = [...latest.models]
        models[index] = {
          ...model,
          settings: {
            ...model.settings,
            ctx_len: {
              ...(model.settings?.ctx_len ?? {}),
              controller_props: {
                ...(model.settings?.ctx_len?.controller_props ?? {}),
                value: plan.raiseTo,
              },
            },
          },
        } as typeof model
        await serviceHub
          .models()
          .updateModelSettings(id, { ctx_len: plan.raiseTo })
        updateProvider('llamacpp', { models })
        const loaded = (await serviceHub.models().getActiveModels()) || []
        if (loaded.includes(id)) {
          await serviceHub.models().stopModel(id, 'llamacpp')
        }
        toast.info(
          t('settings:claudeCode.contextRaised', {
            model: getModelDisplayName(model),
            context: plan.raiseTo.toLocaleString(),
          })
        )
      } catch (e) {
        console.error('Failed to raise the context for Claude Code', e)
      }
    }

    const startServer = async (): Promise<void> => {
      const helperModelsToStart = [
        { id: chosen.fable, role: 'Fable' },
        { id: chosen.big, role: 'Big' },
        { id: chosen.medium, role: 'Medium' },
        { id: chosen.small, role: 'Small' },
      ]
        .filter((m) => m.id)
        .map((m) => m.id as string)

      const loadedModels = (await serviceHub.models().getActiveModels()) || []
      const modelsToStart = helperModelsToStart.filter(
        (m) => !loadedModels.includes(m)
      )

      if (modelsToStart.length > 0) {
        setIsModelLoading(true)
        try {
          for (const modelId of modelsToStart) {
            const providerWithModel = providers.find((p) =>
              p.models.some((m) => m.id === modelId)
            )

            // Remote models need no loading; only local engines can start.
            if (
              providerWithModel &&
              isLocalProvider(providerWithModel.provider)
            ) {
              await serviceHub
                .models()
                .startModel(providerWithModel, modelId, true)
                .then(() => {
                  console.log(`Model ${modelId} started successfully`)
                })
            }
          }
        } finally {
          setIsModelLoading(false)
        }
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
            .finally(() => setIsModelLoading(false))
        }
      }

      let actualPort: number | undefined
      try {
        actualPort = await guardServerStart(
          window.core?.api?.startServer({
            host: serverHost,
            port: serverPort,
            prefix: apiPrefix,
            apiKey,
            trustedHosts,
            isCorsEnabled: corsEnabled,
            isVerboseEnabled: verboseLogs,
            proxyTimeout: proxyTimeout,
            // Omitted, the backend reads it as false (#156).
            enableServerToolExecution,
          })
        )
      } catch (startErr) {
        // `start_server` rejects with { code, message } (ServerStartError).
        const code = (startErr as { code?: unknown } | null)?.code
        if (code !== 'ALREADY_RUNNING') throw startErr
      }

      if (actualPort) {
        // A fallback bind is recorded for this run only, not as the setting.
        setActiveServerPort(actualPort)
        boundPort = actualPort
      }
      setServerStatus('running')

      // Persist whichever models are actually running so next startup can restore them
      const activeModels = await serviceHub
        .models()
        .getActiveModels()
        .catch(() => [] as string[])
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
        toast.info(t('integrations:claudeCode.startingServer'), {
          description: t('integrations:claudeCode.preparingServer'),
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
          toast.error(t('integrations:claudeCode.startFailed'), {
            description: msg,
          })
          return
        }
      }
      await invokeCommand('launch_claude_code_with_config', {
        apiUrl: claudeCodeApiUrl(serverHost, boundPort),
        apiKey: apiKey || undefined,
        bigModel: modelBig || undefined,
        mediumModel: modelMedium || undefined,
        smallModel: modelSmall || undefined,
        fableModel: modelFable || undefined,
        customEnvVars: customEnvVars.map((env) => ({
          key: env.key,
          value: env.value,
        })),
      })
      toast.success(t('integrations:claudeCode.envUpdated'), {
        duration: 8000,
      })
    } catch (error) {
      console.error('Failed to launch Claude Code:', error)
      const errorMsg = error instanceof Error ? error.message : String(error)
      toast.error(t('integrations:claudeCode.configFailed'), {
        description: errorMsg,
      })
    }
  }

  return (
    <>
      <Card
        icon={
          <img
            src="/images/logos/claude-color.svg"
            width={16}
            height={16}
            alt=""
            className="size-4"
          />
        }
        title={t('integrations:claudeCode.cardTitle')}
      >
        <CardItem
          anchor="settings-integrations-claude-code-fable-model"
          title={t('settings:claudeCode.fableModel')}
          description={t('settings:claudeCode.fableModelDesc')}
          actions={
            <HelperModelSelector
              providers={providers}
              selectedModel={helperModels.fable}
              onSelect={(model) => setHelperModel('fable', model)}
              placeholder={t('integrations:claudeCode.selectFable')}
            />
          }
        />
        <CardItem
          anchor="settings-integrations-claude-code-large-model"
          title={t('settings:claudeCode.largeModel')}
          description={t('settings:claudeCode.largeModelDesc')}
          actions={
            <HelperModelSelector
              providers={providers}
              selectedModel={helperModels.big}
              onSelect={(model) => setHelperModel('big', model)}
              placeholder={t('integrations:claudeCode.selectBig')}
            />
          }
        />
        <CardItem
          anchor="settings-integrations-claude-code-medium-model"
          title={t('settings:claudeCode.mediumModel')}
          description={t('settings:claudeCode.mediumModelDesc')}
          actions={
            <HelperModelSelector
              providers={providers}
              selectedModel={helperModels.medium}
              onSelect={(model) => setHelperModel('medium', model)}
              placeholder={t('integrations:claudeCode.selectMedium')}
            />
          }
        />
        <CardItem
          anchor="settings-integrations-claude-code-small-model"
          title={t('settings:claudeCode.smallModel')}
          description={t('settings:claudeCode.smallModelDesc')}
          actions={
            <HelperModelSelector
              providers={providers}
              selectedModel={helperModels.small}
              onSelect={(model) => setHelperModel('small', model)}
              placeholder={t('integrations:claudeCode.selectSmall')}
            />
          }
        />

        <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => setIsCustomCliDialogOpen(true)}
          >
            <Icon name="x-plus" size={14} />
            {t('integrations:envVars')}
          </Button>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={async () => {
                clearModels()
                try {
                  await invokeCommand('clear_claude_code_env')
                  toast.success(t('integrations:claudeCode.cleared'))
                } catch (e) {
                  toast.error(
                    t('integrations:claudeCode.clearFailed', {
                      error: String(e),
                    })
                  )
                }
              }}
            >
              {t('integrations:claudeCode.reset')}
            </Button>
            <Button
              className="pointer-coarse:h-11"
              onClick={handleLaunchClaudeCode}
              disabled={isModelLoading}
            >
              {isModelLoading
                ? t('integrations:claudeCode.loadingModels')
                : t('integrations:claudeCode.saveEnable')}
            </Button>
          </div>
        </div>

        {overrides.length > 0 && (
          <div
            role="status"
            className="mt-2.5 flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm"
          >
            <div className="font-medium">
              {t('settings:claudeCode.overridesTitle')}
            </div>
            {overrides.map((o) => (
              <div key={`${o.kind}:${o.key}`} className="break-words">
                {t(`settings:claudeCode.overrides.${o.kind}`, {
                  key: o.key,
                  value: o.value ?? '',
                  file: o.file,
                })}
              </div>
            ))}
          </div>
        )}

        {contextWarnings.length > 0 && (
          <div
            role="status"
            className="mt-2.5 flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm"
          >
            {contextWarnings.map((w) => (
              <div key={w.id}>{w.text}</div>
            ))}
          </div>
        )}

        {(helperModels.customCli || helperModels.envVars.length > 0) && (
          <div className="mt-2.5 rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-[1.6] text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)]">
            {helperModels.customCli && (
              <div className="break-all">
                {t('integrations:claudeCode.commandLine', {
                  value: helperModels.customCli,
                })}
              </div>
            )}
            {helperModels.envVars.length > 0 && (
              <div className="break-all">
                {t('integrations:claudeCode.envLine', {
                  value: helperModels.envVars
                    .map((env) => `${env.key}=******`)
                    .join(' · '),
                })}
              </div>
            )}
          </div>
        )}
      </Card>
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
    </>
  )
}

function HelperModelSelector({
  providers,
  selectedModel,
  onSelect,
  placeholder,
}: {
  providers: ModelProvider[]
  selectedModel: string | null
  onSelect: (modelId: string) => void
  placeholder?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const hideProvider = useHideUnavailable()

  const availableModels = useMemo(() => {
    return providers
      .filter((p) => p.active)
      .flatMap((p) => {
        const filteredOut = hideProvider(p)
        return p.models
          .filter((m) => !filteredOut || m.id === selectedModel)
          .map((m) => ({
            ...m,
            providerName: p.provider,
            isLocal: isLocalProvider(p.provider),
            hasApiKey: !!p.api_key?.length,
          }))
      })
      .filter((m) => {
        if (m.isLocal) {
          return m.id
        }
        return m.hasApiKey
      })
  }, [providers, hideProvider, selectedModel])

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
          className="w-full max-w-full min-w-[220px] justify-between sm:w-auto pointer-coarse:h-11"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate leading-normal">
            {selectedModel && currentModel ? (
              <>
                <span className="inline-flex h-[18px] shrink-0 items-center rounded-md border-[0.8px] border-border bg-card px-2 text-xs font-medium">
                  {currentModel.isLocal
                    ? t('integrations:claudeCode.local')
                    : t('integrations:claudeCode.remote')}
                </span>
                <BrandMark
                  logo={modelLogo(currentModel.id, currentModel.providerName)}
                  name={formatModelWithSize(currentModel)}
                  size={16}
                  className="rounded-full"
                />
                <span className="min-w-0 flex-1 truncate text-left">
                  {formatModelWithSize(currentModel)}
                </span>
              </>
            ) : (
              (placeholder ?? t('integrations:claudeCode.selectModel'))
            )}
          </span>
          <Icon name="arrow-down" size={12} className="opacity-70" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[min(100vw-2rem,280px)] border border-border bg-popover p-0"
        align="end"
        sideOffset={8}
      >
        <div className="flex flex-col size-full">
          <div className="flex items-center gap-1 border-b border-border p-2">
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={t('integrations:claudeCode.searchModels')}
              className="min-w-0 flex-1 bg-transparent text-base font-normal outline-0 md:text-sm"
            />
            {searchValue.length > 0 && (
              <X
                size={16}
                className="shrink-0 text-muted-foreground cursor-pointer"
                onClick={() => setSearchValue('')}
              />
            )}
            <ModelFilterButton />
          </div>

          <div className="max-h-[300px] overflow-y-auto">
            {Object.keys(groupedModels).length === 0 && searchValue ? (
              <div className="py-3 px-4 text-sm text-muted-foreground">
                {t('integrations:claudeCode.noModels', { search: searchValue })}
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
                      className="mx-1.5 my-1.5 rounded-md bg-muted/50 py-1 first:mt-1"
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
                                'bg-accent shadow-[inset_2px_0_0_var(--primary)] hover:bg-accent'
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
