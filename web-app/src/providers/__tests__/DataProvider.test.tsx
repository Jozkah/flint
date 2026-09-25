import { render, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub the build-time define used by DataProvider
;(globalThis as unknown as { UPDATE_CHECK_INTERVAL_MS: number }).UPDATE_CHECK_INTERVAL_MS = 60_000

// Hoisted shared mocks/state
const h = vi.hoisted(() => {
  return {
    setProviders: vi.fn(),
    updateProvider: vi.fn(),
    getProviderByName: vi.fn(),
    providers: [] as Array<Record<string, unknown>>,
    setServers: vi.fn(),
    setSettings: vi.fn(),
    setAssistants: vi.fn(),
    setThreads: vi.fn(),
    setThreadsLoading: vi.fn(),
    threadsInStore: {} as Record<string, unknown>,
    registrationListeners: new Set<() => void>(),
    setLastServerModels: vi.fn(),
    setServerPort: vi.fn(),
    setServerStatus: vi.fn(),
    navigate: vi.fn(),
    invoke: vi.fn().mockResolvedValue(undefined),
    isDev: vi.fn().mockReturnValue(false),
    providerHasRemoteApiKeys: vi.fn().mockReturnValue(true),
    providerRemoteApiKeyChain: vi.fn().mockReturnValue(['key-1']),
    eventsOn: vi.fn(),
    eventsOff: vi.fn(),
    localApi: {
      enableOnStartup: false,
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      trustedHosts: [],
      corsEnabled: true,
      verboseLogs: false,
      proxyTimeout: 0,
      lastServerModels: [] as Array<{ model: string; provider: string }>,
      defaultModelLocalApiServer: null as null | { model: string; provider: string },
    },
  }
})

// Zustand-style hook with getState support
vi.mock('@/hooks/useModelProvider', () => {
  const useModelProvider = vi.fn(() => ({
    setProviders: h.setProviders,
    getProviderByName: h.getProviderByName,
  })) as unknown as {
    (): unknown
    getState: () => { providers: unknown[]; updateProvider: () => void }
  }
  useModelProvider.getState = () => ({
    providers: h.providers,
    updateProvider: h.updateProvider,
  })
  return { useModelProvider }
})

vi.mock('@/hooks/useAppUpdater', () => ({
}))

vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: () => ({ setServers: h.setServers, setSettings: h.setSettings }),
  DEFAULT_MCP_SETTINGS: { foo: 'bar' },
}))

vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: () => ({ setAssistants: h.setAssistants }),
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      onRegistrationChange: (cb: () => void) => {
        h.registrationListeners.add(cb)
        return () => h.registrationListeners.delete(cb)
      },
    }),
  },
}))

vi.mock('@/hooks/useThreads', () => {
  const state = () => ({
    setThreads: h.setThreads,
    setThreadsLoading: h.setThreadsLoading,
    threads: h.threadsInStore,
  })
  const useThreads = vi.fn((selector?: (s: unknown) => unknown) =>
    selector ? selector(state()) : state()
  ) as unknown as {
    (selector?: (s: unknown) => unknown): unknown
    getState: () => { threads: Record<string, unknown> }
  }
  useThreads.getState = () => ({ threads: h.threadsInStore })
  return { useThreads }
})

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: () => ({
    ...h.localApi,
    setLastServerModels: h.setLastServerModels,
    setServerPort: h.setServerPort,
  }),
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (sel: (s: { setServerStatus: unknown }) => unknown) =>
    sel({ setServerStatus: h.setServerStatus }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
}))

vi.mock('@/lib/utils', () => ({
  isDev: () => h.isDev(),
}))

vi.mock('@/lib/provider-api-keys', () => ({
  providerHasRemoteApiKeys: (p: unknown) => h.providerHasRemoteApiKeys(p),
  providerRemoteApiKeyChain: (p: unknown) => h.providerRemoteApiKeyChain(p),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@janhq/core', () => ({
  AppEvent: { onModelImported: 'onModelImported' },
  events: {
    on: (...a: unknown[]) => h.eventsOn(...a),
    off: (...a: unknown[]) => h.eventsOff(...a),
  },
}))

vi.mock('@/types/events', () => ({
  SystemEvent: { DEEP_LINK: 'deep-link' },
}))

vi.mock('@/constants/routes', () => ({
  route: {},
}))

// Override serviceHub per-test needs. We extend the global setup's mock.
const hubState = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  deeplinkGetCurrent: vi.fn().mockResolvedValue(null),
  deeplinkOnOpenUrl: vi.fn().mockResolvedValue(vi.fn()),
  eventsListen: vi.fn(),
  getProviders: vi.fn().mockResolvedValue([]),
  getMCPConfig: vi.fn().mockResolvedValue({ mcpServers: { a: 1 }, mcpSettings: { s: 1 } }),
  getAssistants: vi.fn().mockResolvedValue([]),
  fetchThreads: vi.fn().mockResolvedValue([]),
  getServerStatus: vi.fn().mockResolvedValue(false),
  setServerRunInBackground: vi.fn().mockResolvedValue(undefined),
  startModel: vi.fn().mockResolvedValue(undefined),
  getActiveModels: vi.fn().mockResolvedValue([]),
  startServer: vi.fn().mockResolvedValue(1337),
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    providers: () => ({ getProviders: hubState.getProviders }),
    mcp: () => ({ getMCPConfig: hubState.getMCPConfig }),
    assistants: () => ({ getAssistants: hubState.getAssistants }),
    threads: () => ({ fetchThreads: hubState.fetchThreads }),
    deeplink: () => ({
      getCurrent: hubState.deeplinkGetCurrent,
      onOpenUrl: hubState.deeplinkOnOpenUrl,
    }),
    events: () => ({
      listen: (...args: unknown[]) => {
        hubState.eventsListen(...args)
        return Promise.resolve(hubState.unsubscribe)
      },
    }),
    app: () => ({
      getServerStatus: hubState.getServerStatus,
      setServerRunInBackground: hubState.setServerRunInBackground,
    }),
    models: () => ({
      startModel: hubState.startModel,
      getActiveModels: hubState.getActiveModels,
    }),
  }
  return {
    useServiceHub: () => hub,
    getServiceHub: () => hub,
    initializeServiceHubStore: vi.fn(),
    isServiceHubInitialized: () => true,
  }
})

// Import after mocks
import { DataProvider } from '../DataProvider'

const resetHubState = () => {
  hubState.getProviders.mockResolvedValue([])
  hubState.getMCPConfig.mockResolvedValue({ mcpServers: { a: 1 }, mcpSettings: { s: 1 } })
  hubState.getAssistants.mockResolvedValue([])
  hubState.fetchThreads.mockResolvedValue([])
  hubState.getServerStatus.mockResolvedValue(false)
  hubState.getActiveModels.mockResolvedValue([])
  hubState.startServer.mockResolvedValue(1337)
  hubState.startModel.mockResolvedValue(undefined)
  hubState.deeplinkGetCurrent.mockResolvedValue(null)
  hubState.deeplinkOnOpenUrl.mockResolvedValue(vi.fn())
}

describe('DataProvider', () => {
  const originalWindowCore = (window as unknown as { core?: unknown }).core

  beforeEach(() => {
    vi.clearAllMocks()
    resetHubState()
    h.providers = []
    h.threadsInStore = {}
    h.registrationListeners.clear()
    h.isDev.mockReturnValue(false)
    h.providerHasRemoteApiKeys.mockReturnValue(true)
    h.providerRemoteApiKeyChain.mockReturnValue(['key-1'])
    h.invoke.mockResolvedValue(undefined)
    h.localApi.enableOnStartup = false
    h.localApi.defaultModelLocalApiServer = null
    h.localApi.lastServerModels = []
    ;(window as unknown as { core: unknown }).core = {
      api: { startServer: hubState.startServer },
    }
  })

  afterEach(() => {
    ;(window as unknown as { core?: unknown }).core = originalWindowCore
  })

  it('renders null (no DOM output)', () => {
    const { container } = render(<DataProvider />)
    expect(container.firstChild).toBeNull()
  })

  it('hydrates providers, mcp config, assistants, threads on mount', async () => {
    hubState.getProviders.mockResolvedValue([
      { provider: 'openai', active: true, models: [{ id: 'gpt' }], custom_header: [] },
    ])
    hubState.getAssistants.mockResolvedValue([{ id: 'a1' }])
    hubState.fetchThreads.mockResolvedValue([{ id: 't1' }])

    render(<DataProvider />)

    await waitFor(() => {
      expect(hubState.getProviders).toHaveBeenCalled()
      expect(hubState.getMCPConfig).toHaveBeenCalled()
      expect(hubState.getAssistants).toHaveBeenCalled()
      expect(hubState.fetchThreads).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(h.setProviders).toHaveBeenCalledWith([
        expect.objectContaining({ provider: 'openai' }),
      ])
      expect(h.setServers).toHaveBeenCalledWith({ a: 1 })
      expect(h.setSettings).toHaveBeenCalledWith({ s: 1 })
      expect(h.setAssistants).toHaveBeenCalledWith([{ id: 'a1' }])
      expect(h.setThreads).toHaveBeenCalledWith([{ id: 't1' }])
    })
  })

  it('retries fetchThreads when it throws (extension not ready) and never wipes the list on failure', async () => {
    hubState.fetchThreads
      .mockRejectedValueOnce(new Error('Conversational extension not available yet'))
      .mockResolvedValueOnce([{ id: 't1' }])

    render(<DataProvider />)

    await waitFor(() => {
      expect(hubState.fetchThreads).toHaveBeenCalledTimes(2)
    })
    // The failed first attempt must not push an empty array.
    expect(h.setThreads).not.toHaveBeenCalledWith([])
    await waitFor(() => {
      expect(h.setThreads).toHaveBeenCalledWith([{ id: 't1' }])
    })
  })

  it('does not wipe a populated thread list when fetchThreads resolves empty', async () => {
    h.threadsInStore = { t1: { id: 't1' } }
    hubState.fetchThreads.mockResolvedValue([])

    render(<DataProvider />)

    await waitFor(() => {
      expect(hubState.fetchThreads).toHaveBeenCalled()
    })
    expect(h.setThreads).not.toHaveBeenCalled()
  })

  it('writes an empty thread list when the store is also empty', async () => {
    hubState.fetchThreads.mockResolvedValue([])

    render(<DataProvider />)

    await waitFor(() => {
      expect(h.setThreads).toHaveBeenCalledWith([])
    })
  })

  it('refetches threads when an extension registers after retries are exhausted', async () => {
    vi.useFakeTimers()
    try {
      hubState.fetchThreads.mockRejectedValue(new Error('not ready'))

      const { unmount } = render(<DataProvider />)

      // 1 initial attempt + 20 bounded retries (backoff capped at 1s).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000)
      })
      expect(hubState.fetchThreads).toHaveBeenCalledTimes(21)
      expect(h.setThreads).not.toHaveBeenCalled()

      // A late extension registration re-arms the fetch.
      hubState.fetchThreads.mockResolvedValue([{ id: 't1' }])
      await act(async () => {
        h.registrationListeners.forEach((cb) => cb())
      })
      expect(hubState.fetchThreads).toHaveBeenCalledTimes(22)
      expect(h.setThreads).toHaveBeenCalledWith([{ id: 't1' }])

      unmount()
      expect(h.registrationListeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes DEFAULT_MCP_SETTINGS when mcp config lacks values', async () => {
    hubState.getMCPConfig.mockResolvedValue({})
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.setServers).toHaveBeenCalledWith({})
      expect(h.setSettings).toHaveBeenCalledWith({ foo: 'bar' })
    })
  })

  it('sets assistants to null when service returns empty array', async () => {
    hubState.getAssistants.mockResolvedValue([])
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.setAssistants).toHaveBeenCalledWith(null)
    })
  })

  it('handles assistants service rejection without crashing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hubState.getAssistants.mockRejectedValue(new Error('boom'))
    render(<DataProvider />)
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'Failed to load assistants, keeping default:',
        expect.any(Error),
      )
    })
    warn.mockRestore()
  })

  it('subscribes to deep link system events and cleans up on unmount', async () => {
    const { unmount } = render(<DataProvider />)
    await waitFor(() => {
      expect(hubState.eventsListen).toHaveBeenCalledWith('deep-link', expect.any(Function))
    })
    // Let the listen().then(unsub => unsubscribe = unsub) resolve
    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    expect(hubState.unsubscribe).toHaveBeenCalled()
  })

  /// janhq/jan#8208. A secret header's value is kept out of settings, so the
  /// store starts with it blank; it has to be read back from the credential
  /// store before the provider is used or registered.
  it('loads secret custom header values before registering the provider', async () => {
    const fetched = [
      {
        provider: 'openai',
        active: true,
        models: [{ id: 'gpt-4' }],
        custom_header: [
          { header: 'X-Tenant', value: 'acme' },
          { header: 'X-Key', value: '', secret: true },
        ],
        base_url: 'https://api',
      },
    ]
    hubState.getProviders.mockResolvedValue(fetched)
    h.providers = fetched
    h.updateProvider.mockImplementation(
      (name: string, data: Record<string, unknown>) => {
        h.providers = h.providers.map((p) =>
          p.provider === name ? { ...p, ...data } : p
        )
      }
    )
    h.invoke.mockImplementation(async (cmd: string, args?: { key?: string }) => {
      if (cmd === 'get_secret' && args?.key === 'provider-headers:openai') {
        return JSON.stringify({ 'x-key': 'loaded-secret-value' })
      }
      return undefined
    })
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith(
        'register_provider_config',
        expect.objectContaining({
          request: expect.objectContaining({
            provider: 'openai',
            custom_headers: [
              { header: 'X-Tenant', value: 'acme', secret: false },
              { header: 'X-Key', value: 'loaded-secret-value', secret: true },
            ],
          }),
        })
      )
    })
    h.updateProvider.mockReset()
  })

  it('registers remote providers with the backend for active providers', async () => {
    const fetched = [
      {
        provider: 'openai',
        active: true,
        models: [{ id: 'gpt-4' }],
        custom_header: [{ header: 'X', value: 'Y' }],
        base_url: 'https://api',
      },
      {
        provider: 'llamacpp',
        active: true,
        models: [],
        custom_header: [],
      },
    ]
    hubState.getProviders.mockResolvedValue(fetched)
    // Registration reads the store after setProviders merges the fetched list.
    h.providers = fetched
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith(
        'register_provider_config',
        expect.objectContaining({
          request: expect.objectContaining({
            provider: 'openai',
            api_key: 'key-1',
            models: ['gpt-4'],
          }),
        }),
      )
    })
    // llamacpp should be skipped
    const calls = h.invoke.mock.calls.filter(
      (c) => c[0] === 'register_provider_config' && (c[1] as { request: { provider: string } }).request.provider === 'llamacpp',
    )
    expect(calls.length).toBe(0)
  })

  // #139: the backend picks its wire converter by api_type, so it has to be
  // sent -- for the built-in anthropic provider and for a custom provider
  // configured as Anthropic.
  it('registers each provider with the wire format it speaks', async () => {
    const fetched = [
      { provider: 'anthropic', active: true, models: [{ id: 'claude' }], custom_header: [], base_url: 'https://a' },
      { provider: 'my-proxy', api_type: 'anthropic', active: true, models: [{ id: 'm' }], custom_header: [], base_url: 'https://p' },
      { provider: 'openai', active: true, models: [{ id: 'gpt-4' }], custom_header: [], base_url: 'https://o' },
    ]
    hubState.getProviders.mockResolvedValue(fetched)
    h.providers = fetched
    render(<DataProvider />)
    const sent = () =>
      Object.fromEntries(
        h.invoke.mock.calls
          .filter((c) => c[0] === 'register_provider_config')
          .map((c) => {
            const r = (c[1] as { request: { provider: string; api_type?: string } }).request
            return [r.provider, r.api_type]
          })
      )
    await waitFor(() => expect(Object.keys(sent())).toHaveLength(3))
    expect(sent()).toEqual({ anthropic: 'anthropic', 'my-proxy': 'anthropic', openai: 'openai' })
  })

  it('skips registration when provider has no API key chain', async () => {
    h.providerRemoteApiKeyChain.mockReturnValue([])
    h.providers = [
      { provider: 'openai', active: true, models: [], custom_header: [] },
    ]
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.providerRemoteApiKeyChain).toHaveBeenCalled()
    })
    const regCalls = h.invoke.mock.calls.filter((c) => c[0] === 'register_provider_config')
    expect(regCalls.length).toBe(0)
  })

  it('logs provider registration failures without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.invoke.mockRejectedValue(new Error('nope'))
    const fetched = [
      { provider: 'openai', active: true, models: [], custom_header: [] },
    ]
    hubState.getProviders.mockResolvedValue(fetched)
    h.providers = fetched
    render(<DataProvider />)
    await waitFor(() => {
      expect(err).toHaveBeenCalledWith(
        expect.stringContaining('Failed to register provider openai'),
        expect.any(Error),
      )
    })
    err.mockRestore()
  })

  it('registers a listener for onModelImported events', async () => {
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.eventsOn).toHaveBeenCalledWith('onModelImported', expect.any(Function))
    })
  })

  it('does not start server on mount when enableOnStartup is false', async () => {
    render(<DataProvider />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(hubState.getServerStatus).not.toHaveBeenCalled()
    expect(hubState.startServer).not.toHaveBeenCalled()
  })

  it('short-circuits when server is already running', async () => {
    h.localApi.enableOnStartup = true
    hubState.getServerStatus.mockResolvedValue(true)
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.setServerStatus).toHaveBeenCalledWith('running')
    })
    expect(hubState.startServer).not.toHaveBeenCalled()
  })

  it('starts default model and local API server when enabled', async () => {
    h.localApi.enableOnStartup = true
    h.localApi.defaultModelLocalApiServer = { model: 'm1', provider: 'openai' }
    h.getProviderByName.mockReturnValue({ provider: 'openai' })
    hubState.getServerStatus.mockResolvedValue(false)
    hubState.startServer.mockResolvedValue(2000)
    hubState.getActiveModels.mockResolvedValue(['m1'])
    h.providers = [{ provider: 'openai', models: [{ id: 'm1' }] }]

    render(<DataProvider />)

    await waitFor(() => {
      expect(h.setServerStatus).toHaveBeenCalledWith('pending')
      expect(hubState.startModel).toHaveBeenCalled()
      expect(hubState.startServer).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(h.setServerPort).toHaveBeenCalledWith(2000)
      expect(h.setServerStatus).toHaveBeenCalledWith('running')
      expect(h.setLastServerModels).toHaveBeenCalledWith([
        { model: 'm1', provider: 'openai' },
      ])
    })
  })

  // #156: an omitted flag reads as false on the backend, so the auto-start
  // must pass the persisted "Execute tools on server" setting through.
  it('auto-starts the server with the persisted server tool execution setting', async () => {
    h.localApi.enableOnStartup = true
    ;(h.localApi as Record<string, unknown>).enableServerToolExecution = true
    hubState.getServerStatus.mockResolvedValue(false)
    render(<DataProvider />)
    await waitFor(() => expect(hubState.startServer).toHaveBeenCalled())
    expect(hubState.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ enableServerToolExecution: true })
    )
    delete (h.localApi as Record<string, unknown>).enableServerToolExecution
  })

  it('sets server status to stopped on startup failure', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.localApi.enableOnStartup = true
    hubState.getServerStatus.mockRejectedValue(new Error('fail'))
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.setServerStatus).toHaveBeenCalledWith('stopped')
    })
    err.mockRestore()
  })

  it('ignores a deep link, having no hub to open', async () => {
    // The link's only destination was a model's Hub page, which offered a
    // download. Nothing navigates now.
    const deeplinkUrl = 'jan://host/action/owner/repo'
    hubState.deeplinkGetCurrent.mockResolvedValue([deeplinkUrl])
    render(<DataProvider />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it('ignores deep links with insufficient path segments', async () => {
    hubState.deeplinkGetCurrent.mockResolvedValue(['jan://only'])
    render(<DataProvider />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it('ignores null deep link payload', async () => {
    hubState.deeplinkGetCurrent.mockResolvedValue(null)
    render(<DataProvider />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(h.navigate).not.toHaveBeenCalled()
  })
})
