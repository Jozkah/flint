/**
 * The DataProvider's work, one hook per concern: startup hydration, thread
 * loading, provider registration with the backend, tray/download settings,
 * sleep inhibit and the Local API Server auto-start.
 */
import { useModelProvider } from '@/hooks/useModelProvider'
import { invokeCommand } from '@/lib/backend'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'

import {
  useGeneralSetting,
  loadHuggingfaceToken,
} from '@/hooks/useGeneralSetting'
import { useEffect, useRef } from 'react'
import { useMCPServers, DEFAULT_MCP_SETTINGS } from '@/hooks/useMCPServers'
import { useAssistant } from '@/hooks/useAssistant'
import { useBedrockCredentials } from '@/hooks/useBedrockCredentials'
import { useThreads } from '@/hooks/useThreads'
import { ExtensionManager } from '@/lib/extension'
import { whenExtensionsLoaded } from '@/lib/extensionEvents'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { errorText } from '@/lib/errorText'
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
import { startKeepAwakeSync } from '@/lib/keepAwake'
import { isChatWindow } from '@/lib/soloFlag'
import { restoreInterruptedDownloads } from '@/lib/restoreInterruptedDownloads'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { grandfatherFolderTrust } from '@/lib/grandfatherFolderTrust'
import {
  keyringKeysToApply,
  providerHasRemoteApiKeys,
  providerRemoteApiKeyChain,
} from '@/lib/provider-api-keys'
import {
  fillSecretHeaderValues,
  loadSecretHeaderValues,
} from '@/lib/providerHeaderSecrets'

import type { ServiceHub } from '@/services'

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
    await invokeCommand('register_provider_config', { request })
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
        const keys = await invokeCommand<string[]>('get_provider_keys', {
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
    // Read the store again: the keyring read above is async, and a key the
    // user typed meanwhile must not be replaced by the older stored one.
    const current = useModelProvider
      .getState()
      .providers.find((x) => x.provider === p.provider)
    const next = keyringKeysToApply(current, p)
    if (next) store.updateProvider(p.provider, next)
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
      invokeCommand('unregister_provider_config', { provider: name }).catch(() => {})
    }
  }

  registeredProviderNames = currentActive

  syncTlsTrust(providers)
}

// Providers the backend currently skips certificate verification for, so a
// provider that was switched off or removed is cleared there too.
let trustedProviderNames = new Set<string>()

// "Allow invalid certificates" is per provider and applies to that provider's
// own base URL only. Sent for keyless providers as well (the usual case for a
// self-signed gateway), which `registerRemoteProvider` skips.
function syncTlsTrust(providers: ModelProvider[]) {
  const now = new Set<string>()
  providers.forEach((provider) => {
    if (provider.provider === 'llamacpp') return
    const allow = provider.allow_invalid_certs === true && !!provider.base_url
    if (allow) now.add(provider.provider)
    if (allow || trustedProviderNames.has(provider.provider)) {
      invokeCommand('set_provider_tls_trust', {
        provider: provider.provider,
        baseUrl: provider.base_url ?? null,
        allowInvalidCerts: allow,
      }).catch(() => {})
    }
  })
  // A provider removed from the list while it was trusted.
  const listed = new Set(providers.map((p) => p.provider))
  trustedProviderNames.forEach((name) => {
    if (!listed.has(name)) {
      invokeCommand('set_provider_tls_trust', {
        provider: name,
        baseUrl: null,
        allowInvalidCerts: false,
      }).catch(() => {})
    }
  })
  trustedProviderNames = now
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

  invokeCommand('set_model_param_defaults', { defaults }).catch((e) =>
    console.error('Failed to sync model param defaults:', e)
  )
}

// A "New window" shows one conversation of an app that is already running: it
// loads what a conversation needs and leaves the one-time work (provider
// registration, server auto-start, tray and download settings, deep links, the
// workspace sweep) to the main window. Fixed for the life of the window.
const solo = isChatWindow()


/** Whether Bedrock's AWS credentials are saved decides if it counts as usable. */
export function useBedrockCredentialRefresh() {
  useEffect(() => {
    void useBedrockCredentials.getState().refresh()
  }, [])
}

/**
 * Hugging Face downloads a quit or crash cut off come back as paused rows.
 * Main window only: a second window restoring them would run them twice.
 */
export function useInterruptedDownloadRestore(serviceHub: ServiceHub) {
  useEffect(() => {
    if (solo) return
    try {
      if (getCurrentWebviewWindow().label !== 'main') return
    } catch {
      // Not under Tauri (tests, the browser build): treat as the main window.
    }
    restoreInterruptedDownloads(serviceHub)
  }, [serviceHub])
}

/**
 * Startup reads: providers (with keyring keys and secret headers, then
 * backend registration), the Hugging Face token, the MCP config, assistants,
 * and the deep-link listeners.
 */
export function useBootHydration(
  serviceHub: ServiceHub,
  handleDeepLink: (urls: string[] | null) => void
) {
  // Actions only: the whole store would re-render this provider on every
  // provider edit and model-list change.
  const setProviders = useModelProvider((s) => s.setProviders)
  const setServers = useMCPServers((s) => s.setServers)
  const setSettings = useMCPServers((s) => s.setSettings)
  const setAssistants = useAssistant((s) => s.setAssistants)
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
      try {
        await applyKeyringKeys()
      } catch (e) {
        console.error('Could not seed provider keys from the keyring:', e)
      }
      try {
        await applySecretHeaderValues()
      } catch (e) {
        console.error('Could not load secret provider header values:', e)
      }
      // Register active remote providers with the backend, keys now in place.
      useModelProvider.getState().providers.forEach((provider) => {
        if (provider.active && !solo) {
          registerRemoteProvider(provider)
          registeredProviderNames.add(provider.provider)
        }
      })
    }).catch((e) => console.error('Could not load providers:', e))
    // Re-seed the Hugging Face token from the keyring (no longer persisted to
    // settings storage) into the store + download extension for this session.
    if (!solo) {
      loadHuggingfaceToken(
        (command, args) => invokeCommand(command, args),
        useModelProvider
          .getState()
          .providers.find((p) => p.provider === 'huggingface')?.api_key
      )
        .then((token) => {
          if (token) useGeneralSetting.getState().setHuggingfaceToken(token)
        })
        .catch(() => {})
    }
    serviceHub
      .mcp()
      .getMCPConfig()
      .then((data) => {
        setServers(data.mcpServers ?? {})
        setSettings(data.mcpSettings ?? DEFAULT_MCP_SETTINGS)
      })
      .catch((e) => console.error('Could not load the MCP config:', e))
    let cancelled = false
    // Reads can overlap (the mount read, the post-load read, a retry) and a
    // slow one must never overwrite a newer one, so only the latest applies.
    let assistantSeq = 0
    const loadAssistants = async (attempt = 0): Promise<void> => {
      const seq = ++assistantSeq
      try {
        const data = await serviceHub.assistants().getAssistants()
        if (cancelled || seq !== assistantSeq) return
        // Only update assistants if we have valid data
        if (data && Array.isArray(data) && data.length > 0) {
          setAssistants(data as unknown as Assistant[])
        } else {
          setAssistants(null)
        }
      } catch (error) {
        console.warn('Failed to load assistants, keeping default:', error)
        // A busy machine can fail a read (a stalled fs call); try again
        // rather than leaving the list on the default until a reload.
        if (!cancelled && seq === assistantSeq && attempt < 4) {
          setTimeout(() => {
            if (!cancelled && seq === assistantSeq) void loadAssistants(attempt + 1)
          }, 1000 * 2 ** attempt)
        }
      }
    }
    void loadAssistants()
    // First launch seeds the starter assistants inside the extension's
    // onLoad. If the UI mounted before that finished, the read above saw a
    // partial folder; read again once loading settles. The wait is latched, so
    // it also fires when loading finished before this effect subscribed.
    void whenExtensionsLoaded().then(() => {
      if (!cancelled) void loadAssistants()
    })
    let unsubscribeOpenUrl: (() => void) | undefined
    if (solo) {
      return () => {
        cancelled = true
      }
    }
    serviceHub
      .deeplink()
      .getCurrent()
      .then(handleDeepLink)
      .catch((e) => console.warn('Deep link getCurrent failed:', e))
    serviceHub
      .deeplink()
      .onOpenUrl(handleDeepLink)
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubscribeOpenUrl = unsub
      })
      .catch((e) => console.warn('Deep link registration failed:', e))

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
      .catch((e) => console.warn('Deep link event listen failed:', e))
    return () => {
      cancelled = true
      unsubscribeOpenUrl?.()
      unsubscribe?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub])
}

/** The thread list, retried while the conversational extension is still loading. */
export function useThreadsHydration(serviceHub: ServiceHub) {
  const setThreads = useThreads((s) => s.setThreads)
  const setThreadsLoading = useThreads((s) => s.setThreadsLoading)
  // The thread fetch re-runs on extension re-registration; the sandbox sweep
  // should not.
  const sweptWorkspaces = useRef(false)
  const grandfathered = useRef(false)
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
          // Sessions and chats are both loaded now: the one-time migration that
          // keeps hooks on for folders the person already works in can run. It does
          // nothing after the first time.
          if (IS_TAURI && !grandfathered.current) {
            grandfathered.current = true
            void grandfatherFolderTrust()
          }
          // Collect agent sandboxes whose thread is gone (crash, or a thread
          // deleted while the app was closed). Once per session, and only on a
          // non-empty result: sweeping against an empty list would delete live
          // sandboxes if this fetch were still a transient not-ready state.
          // Leftovers then wait for the next startup that does see threads.
          if (!solo && !sweptWorkspaces.current && threads.length > 0) {
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
}

/** Register providers with the backend when they change or a model is imported. */
export function useProviderBackendSync(serviceHub: ServiceHub) {
  const setProviders = useModelProvider((s) => s.setProviders)
  // Sync remote providers with backend when providers change
  const providers = useModelProvider((s) => s.providers)
  useEffect(() => {
    if (solo) return
    syncRemoteProviders()
    syncModelParamDefaults()
  }, [providers])

  // Re-read providers after a model import.
  useEffect(() => {
    const handler = () => {
      serviceHub.providers().getProviders().then(async (fetched) => {
        setProviders(fetched)
        await applyKeyringKeys()
        syncRemoteProviders()
        syncModelParamDefaults()
      }).catch((e) => console.error('Could not refresh providers:', e))
    }
    events.on(AppEvent.onModelImported, handler)
    return () => {
      events.off(AppEvent.onModelImported, handler)
    }
  }, [serviceHub, setProviders])
}

/** Hold off system sleep while a run is live (desktop, Windows). */
export function useSleepInhibit() {
  useEffect(() => {
    if (solo || !IS_TAURI) return
    return startKeepAwakeSync()
  }, [])
}

/** Keep the backend's run-in-background, close-to-tray and download cap in sync. */
export function useTraySettingsSync(serviceHub: ServiceHub) {
  const { runInBackground } = useLocalApiServer()
  const closeToTray = useGeneralSetting((state) => state.closeToTray)
  const downloadLimitMBps = useGeneralSetting(
    (state) => state.downloadLimitMBps
  )
  useEffect(() => {
    if (solo) return
    serviceHub
      .app()
      .setServerRunInBackground(runInBackground)
      .catch((error) =>
        console.error('Failed to sync run-in-background setting:', error)
      )
  }, [serviceHub, runInBackground])

  // Keep the backend's close-to-tray flag and download speed cap in sync
  useEffect(() => {
    if (solo) return
    serviceHub
      .app()
      .setCloseToTray(closeToTray)
      .catch((error) =>
        console.error('Failed to sync close-to-tray setting:', error)
      )
  }, [serviceHub, closeToTray])

  useEffect(() => {
    if (solo) return
    serviceHub
      .app()
      .setDownloadSpeedLimit(Math.round(downloadLimitMBps * 1024 * 1024))
      .catch((error) =>
        console.error('Failed to sync download speed limit:', error)
      )
  }, [serviceHub, downloadLimitMBps])
}

/** Auto-start the Local API Server on app startup if enabled. */
export function useLocalApiAutoStart(serviceHub: ServiceHub) {
  const getProviderByName = useModelProvider((s) => s.getProviderByName)
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
    enableServerToolExecution,
  } = useLocalApiServer()
  const setServerStatus = useAppState((state) => state.setServerStatus)
  useEffect(() => {
    if (enableOnStartup && !solo) {
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
            // Removed together after every start settled: each failure
            // filtering the list captured at mount kept only its own removal
            // (LIBC-035).
            const unloadable: { model: string; provider: string }[] = []
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
                  // errorText: JSON.stringify of an Error is `{}` (LIBC-034).
                  if (/image or video generation model/.test(errorText(err))) {
                    unloadable.push({ model, provider: providerName })
                  }
                }
              })
            )
            if (unloadable.length > 0) {
              setLastServerModels(
                useLocalApiServer
                  .getState()
                  .lastServerModels.filter(
                    (m) =>
                      !unloadable.some(
                        (u) => u.model === m.model && u.provider === m.provider
                      )
                  )
              )
            }
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
}
