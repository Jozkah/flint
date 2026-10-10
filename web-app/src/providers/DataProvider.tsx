import { useModelProvider } from '@/hooks/useModelProvider'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'

import {
  useGeneralSetting,
  loadHuggingfaceToken,
} from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { repoFromDeepLink } from '@/lib/huggingface'
import { useMCPServers, DEFAULT_MCP_SETTINGS } from '@/hooks/useMCPServers'
import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { ExtensionManager } from '@/lib/extension'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { getProviderApiType } from '@/lib/providerCaps'
import { useAppState } from '@/hooks/useAppState'
import {
  guardServerStart,
  MODEL_LOAD_WATCHDOG_MS,
  withTimeout,
} from '@/lib/utils'
import { AppEvent, events } from '@janhq/core'
import { SystemEvent } from '@/types/events'
import { sweepThreadWorkspaces } from '@/lib/agentTools'
import { invoke } from '@tauri-apps/api/core'
import { hostInvoke } from '@/lib/hostInvoke'
import { providerHasRemoteApiKeys, providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import {
  fillSecretHeaderValues,
  loadSecretHeaderValues,
} from '@/lib/providerHeaderSecrets'

type RegisteredCustomHeader = {
  header: string
  value: string
  /** The backend redacts this value from everything it logs. */
  secret: boolean
}

type RegisterProviderRequest = {
  provider: string
  api_key?: string
  api_keys?: string[]
  base_url?: string
  custom_headers: RegisteredCustomHeader[]
  models: string[]
  /** The wire format the provider speaks. The Local API proxy and the agent
   * loop pick their request converter by it; without it every provider was
   * forwarded as OpenAI chat/completions (#139). */
  api_type: ProviderApiType
}

async function registerRemoteProvider(provider: ModelProvider) {
  // Skip llamacpp - those are local models
  if (provider.provider === 'llamacpp') return

  const chain = providerRemoteApiKeyChain(provider)
  if (chain.length === 0) {
    console.log(`Provider ${provider.provider} has no API key, skipping registration`)
    return
  }

  const request: RegisterProviderRequest = {
    provider: provider.provider,
    api_key: chain[0],
    api_keys: chain.slice(1),
    base_url: provider.base_url,
    custom_headers: (provider.custom_header || []).map((h) => ({
      header: h.header,
      value: h.value,
      secret: !!h.secret,
    })),
    models: provider.models.map(e => e.id),
    api_type: getProviderApiType(provider),
  }

  try {
    await hostInvoke('register_provider_config', { request })
    console.debug(`Registered remote provider: ${provider.provider}`)
  } catch (error) {
    console.error(`Failed to register provider ${provider.provider}:`, error)
  }
}

// Re-seed in-memory provider keys from the OS keyring. Keys are no longer
// persisted to settings storage (stripped by useModelProvider.partialize), so
// after a reload the store has none; synchronous consumers (model-factory,
// presence checks) read provider.api_key, so we repopulate the runtime objects.
async function seedProviderKeysFromKeyring(
  providers: ModelProvider[]
): Promise<ModelProvider[]> {
  return Promise.all(
    providers.map(async (provider) => {
      if (provider.provider === 'llamacpp') return provider
      try {
        const keys = await hostInvoke<string[]>('get_provider_keys', {
          provider: provider.provider,
        })
        if (!keys || keys.length === 0) return provider
        return {
          ...provider,
          api_key: keys[0],
          api_key_fallbacks: keys.slice(1),
        }
      } catch (error) {
        console.warn(
          `Failed to load keyring keys for ${provider.provider}:`,
          error
        )
        return provider
      }
    })
  )
}

// Re-seed keyring keys into the store for EVERY provider, including
// user-added custom ones (getProviders() only returns predefined + engine
// providers, so custom providers would otherwise stay keyless after a reload).
// Applies via updateProvider so it merges over the already-hydrated state.
async function applyKeyringKeys(): Promise<void> {
  const store = useModelProvider.getState()
  const seeded = await seedProviderKeysFromKeyring(store.providers)
  for (const p of seeded) {
    const current = store.providers.find((x) => x.provider === p.provider)
    if (p.api_key && p.api_key !== current?.api_key) {
      store.updateProvider(p.provider, {
        api_key: p.api_key,
        api_key_fallbacks: p.api_key_fallbacks,
      })
    }
  }
}

// Secret custom header values are not persisted either (stripProviderSecrets
// blanks them); read them back from the credential store the same way.
// janhq/jan#8208.
async function applySecretHeaderValues(): Promise<void> {
  const store = useModelProvider.getState()
  await Promise.all(
    store.providers.map(async (provider) => {
      const rows = provider.custom_header ?? []
      if (!rows.some((h) => h.secret)) return
      const values = await loadSecretHeaderValues(provider.provider)
      store.updateProvider(provider.provider, {
        custom_header: fillSecretHeaderValues(rows, values),
      })
    })
  )
}

// Track which providers have been registered so we can unregister stale ones
let registeredProviderNames = new Set<string>()

// Effect to sync remote providers when providers change
const syncRemoteProviders = () => {
  const providers = useModelProvider.getState().providers
  const currentActive = new Set<string>()

  providers.forEach((provider) => {
    if (
      provider.active &&
      provider.provider !== 'llamacpp' &&
      providerHasRemoteApiKeys(provider)
    ) {
      registerRemoteProvider(provider)
      currentActive.add(provider.provider)
    }
  })

  // Unregister providers that were previously registered but are now inactive/removed
  for (const name of registeredProviderNames) {
    if (!currentActive.has(name)) {
      hostInvoke('unregister_provider_config', { provider: name }).catch(() => {})
    }
  }

  registeredProviderNames = currentActive
}

// MLX honors only these samplers; map Flint's setting keys to MLX request-body
// keys (note repeat_penalty → repetition_penalty). llamacpp uses the router
// preset and remote providers are intentionally excluded.
const MLX_SAMPLING_KEY_MAP: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'top_p',
  repeat_penalty: 'repetition_penalty',
}

// Push per-model MLX sampling defaults to the API server so external clients
// that omit these params inherit the GUI-configured values (overridable
// per-request). Replaces the whole map, so an empty push clears stale entries.
const syncModelParamDefaults = () => {
  const providers = useModelProvider.getState().providers
  const defaults: Record<string, Record<string, number>> = {}

  for (const provider of providers) {
    if (provider.provider !== 'mlx' || !provider.active) continue
    for (const model of provider.models) {
      const out: Record<string, number> = {}
      for (const [janKey, mlxKey] of Object.entries(MLX_SAMPLING_KEY_MAP)) {
        const v = model.settings?.[janKey]?.controller_props?.value
        if (typeof v === 'number' && Number.isFinite(v)) out[mlxKey] = v
      }
      if (Object.keys(out).length > 0) defaults[model.id] = out
    }
  }

  hostInvoke('set_model_param_defaults', { defaults }).catch((e) =>
    console.error('Failed to sync model param defaults:', e)
  )
}

export function DataProvider() {
  const navigate = useNavigate()
  const { setProviders, getProviderByName } =
    useModelProvider()

  const { setServers, setSettings } = useMCPServers()
  const { setAssistants } = useAssistant()
  const { setThreads } = useThreads()
  const setThreadsLoading = useThreads((s) => s.setThreadsLoading)
  // The thread fetch re-runs on extension re-registration; the sandbox sweep
  // should not.
  const sweptWorkspaces = useRef(false)
  const serviceHub = useServiceHub()

  // Local API Server hooks
  const {
    enableOnStartup,
    serverHost,
    serverPort,
    setActiveServerPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    corsEnabled,
    verboseLogs,
    proxyTimeout,
    lastServerModels,
    setLastServerModels,
    defaultModelLocalApiServer,
    runInBackground,
    enableServerToolExecution,
  } = useLocalApiServer()
  const closeToTray = useGeneralSetting((state) => state.closeToTray)
  const downloadLimitMBps = useGeneralSetting(
    (state) => state.downloadLimitMBps
  )
  const setServerStatus = useAppState((state) => state.setServerStatus)

  useEffect(() => {
    console.log('Initializing DataProvider...')
    serviceHub.providers().getProviders().then(async (fetched) => {
      setProviders(fetched)
      // Stars saved before they recorded a provider belong to the providers
      // that list the model.
      useFavoriteModel
        .getState()
        .assignLegacyProviders(useModelProvider.getState().providers)
      // Seed keyring keys into the merged store (predefined + engine + custom).
      await applyKeyringKeys()
      await applySecretHeaderValues()
      // Register active remote providers with the backend, keys now in place.
      useModelProvider.getState().providers.forEach((provider) => {
        if (provider.active) {
          registerRemoteProvider(provider)
          registeredProviderNames.add(provider.provider)
        }
      })
    })
    // Re-seed the Hugging Face token from the keyring (no longer persisted to
    // settings storage) into the store + download extension for this session.
    loadHuggingfaceToken(
      (command, args) => invoke(command, args),
      useModelProvider
        .getState()
        .providers.find((p) => p.provider === 'huggingface')?.api_key
    )
      .then((token) => {
        if (token) useGeneralSetting.getState().setHuggingfaceToken(token)
      })
      .catch(() => {})
    serviceHub
      .mcp()
      .getMCPConfig()
      .then((data) => {
        setServers(data.mcpServers ?? {})
        setSettings(data.mcpSettings ?? DEFAULT_MCP_SETTINGS)
      })
    serviceHub
      .assistants()
      .getAssistants()
      .then((data) => {
        // Only update assistants if we have valid data
        if (data && Array.isArray(data) && data.length > 0) {
          setAssistants(data as unknown as Assistant[])
        } else {
          setAssistants(null)
        }
      })
      .catch((error) => {
        console.warn('Failed to load assistants, keeping default:', error)
      })
    serviceHub.deeplink().getCurrent().then(handleDeepLink)

    let cancelled = false
    let unsubscribeOpenUrl: (() => void) | undefined
    serviceHub
      .deeplink()
      .onOpenUrl(handleDeepLink)
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubscribeOpenUrl = unsub
      })

    // Listen for deep link events
    let unsubscribe: (() => void) | undefined
    serviceHub
      .events()
      .listen(SystemEvent.DEEP_LINK, (event) => {
        const deep_link = event.payload as string
        handleDeepLink([deep_link])
      })
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubscribe = unsub
      })
    return () => {
      cancelled = true
      unsubscribeOpenUrl?.()
      unsubscribe?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub])

  useEffect(() => {
    // fetchThreads throws while the Conversational extension is still loading
    // (startup race, e.g. reload mid-stream). Retry with backoff instead of
    // letting a single failed fetch leave the thread list permanently empty.
    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      serviceHub
        .threads()
        .fetchThreads()
        .then((threads) => {
          if (cancelled) return
          // Never overwrite a populated list with an empty fetch result: an
          // empty array here is more likely a transient not-ready state than
          // the user having zero threads.
          if (
            threads.length === 0 &&
            Object.keys(useThreads.getState().threads).length > 0
          ) {
            return
          }
          setThreads(threads)
          setThreadsLoading(false)
          // Collect agent sandboxes whose thread is gone (crash, or a thread
          // deleted while the app was closed). Once per session, and only on a
          // non-empty result: sweeping against an empty list would delete live
          // sandboxes if this fetch were still a transient not-ready state.
          // Leftovers then wait for the next startup that does see threads.
          if (!sweptWorkspaces.current && threads.length > 0) {
            sweptWorkspaces.current = true
            sweepThreadWorkspaces(threads.map((t) => t.id))
          }
        })
        .catch(() => {
          if (cancelled) return
          if (attempt >= 20) {
            setThreadsLoading(false)
            return
          }
          attempt += 1
          timer = setTimeout(load, Math.min(1000, 150 * attempt))
        })
    }
    // A late (or re-)registration re-arms the fetch even after the bounded
    // retries above are exhausted, e.g. when extension setup itself failed
    // and only recovers later.
    const unsubscribe = ExtensionManager.getInstance().onRegistrationChange(
      () => {
        if (cancelled) return
        attempt = 0
        clearTimeout(timer)
        load()
      }
    )
    load()
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [serviceHub, setThreads, setThreadsLoading])

  // Sync remote providers with backend when providers change
  const providers = useModelProvider((s) => s.providers)
  useEffect(() => {
    syncRemoteProviders()
    syncModelParamDefaults()
  }, [providers])

  // Check for app updates - initial check and periodic interval
  useEffect(() => {
    const handler = () => {
      serviceHub.providers().getProviders().then(async (fetched) => {
        setProviders(fetched)
        await applyKeyringKeys()
        syncRemoteProviders()
        syncModelParamDefaults()
      })
    }
    events.on(AppEvent.onModelImported, handler)
    return () => {
      events.off(AppEvent.onModelImported, handler)
    }
  }, [serviceHub, setProviders])

  // Keep the backend's hide-to-tray-on-close flag in sync with the setting
  useEffect(() => {
    serviceHub
      .app()
      .setServerRunInBackground(runInBackground)
      .catch((error) =>
        console.error('Failed to sync run-in-background setting:', error)
      )
  }, [serviceHub, runInBackground])

  // Keep the backend's close-to-tray flag and download speed cap in sync
  useEffect(() => {
    serviceHub
      .app()
      .setCloseToTray(closeToTray)
      .catch((error) =>
        console.error('Failed to sync close-to-tray setting:', error)
      )
  }, [serviceHub, closeToTray])

  useEffect(() => {
    serviceHub
      .app()
      .setDownloadSpeedLimit(Math.round(downloadLimitMBps * 1024 * 1024))
      .catch((error) =>
        console.error('Failed to sync download speed limit:', error)
      )
  }, [serviceHub, downloadLimitMBps])

  // Auto-start Local API Server on app startup if enabled
  useEffect(() => {
    if (enableOnStartup) {
      // Check if server is already running
      serviceHub
        .app()
        .getServerStatus()
        .then(async (isRunning) => {
          if (isRunning) {
            console.log('Local API Server is already running')
            setServerStatus('running')
            return
          }

          setServerStatus('pending')

          // Start model(s): prefer user-configured default, fall back to last session's models
          const modelsToStart = (() => {
            if (defaultModelLocalApiServer) {
              return [defaultModelLocalApiServer]
            }
            return lastServerModels
          })()

          if (modelsToStart.length > 0) {
            await Promise.allSettled(
              modelsToStart.map(async ({ model, provider: providerName }) => {
                const provider = getProviderByName(providerName)
                if (!provider) return
                try {
                  await withTimeout(
                    serviceHub.models().startModel(provider, model, true),
                    MODEL_LOAD_WATCHDOG_MS,
                    `Timed out waiting for model ${model} to load.`
                  )
                  console.log(`Auto-started server model: ${model}`)
                } catch (err) {
                  console.warn(`Failed to auto-start server model ${model}:`, err)
                  // A picture or video model cannot load in the chat engine, so
                  // trying it again at every launch only repeats the error.
                  if (/image or video generation model/.test(JSON.stringify(err))) {
                    setLastServerModels(
                      lastServerModels.filter(
                        (m) => !(m.model === model && m.provider === providerName)
                      )
                    )
                  }
                }
              })
            )
          }

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
              // Omitted, the backend reads it as false and silently turns off
              // the setting the user enabled (#156).
              enableServerToolExecution,
            })
          )
            .then(async (actualPort: number | undefined) => {
              // Track the port actually bound (mobile port 0, or a fallback)
              // without overwriting the user's configured port.
              if (actualPort) setActiveServerPort(actualPort)
              setServerStatus('running')
              // Persist whichever models are actually running so next startup can restore them
              const activeModels = await serviceHub.models().getActiveModels().catch(() => [] as string[])
              if (activeModels.length > 0) {
                const allProviders = useModelProvider.getState().providers
                const serverModels = activeModels.flatMap((id) => {
                  const p = allProviders.find((p) => p?.models?.some((m: { id: string }) => m.id === id))
                  return p ? [{ model: id, provider: p.provider }] : []
                })
                if (serverModels.length > 0) setLastServerModels(serverModels)
              }
            })
        })
        .catch((error: unknown) => {
          console.error('Failed to start Local API Server on startup:', error)
          setServerStatus('stopped')
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub])

  /**
   * A model link opens that model's page in Discover. Opening the page is the
   * only thing it does: Hugging Face is contacted when the page loads, and a
   * download still needs the user's own click. Anything that is not a plain
   * owner/name model link is ignored.
   */
  const handleDeepLink = (urls: string[] | null) => {
    const repo = urls?.length ? repoFromDeepLink(urls[0]) : null
    if (!repo) return
    navigate({ to: route.hub.model, params: { modelId: repo }, search: { repo } })
  }

  return null
}
