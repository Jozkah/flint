import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all external dependencies before imports
vi.mock('@/lib/providerFetch', () => ({
  // Provider requests go through the canonical transport now; this is the
  // seam that used to be `@tauri-apps/plugin-http`.
  providerFetch: vi.fn(),
  runtimeProviderFetch: vi.fn(),
  hasTauriRuntime: vi.fn(() => true),
  endpointDiagnostics: vi.fn(async () => null),
  refreshEndpoint: vi.fn(async () => undefined),
  endpointOf: vi.fn(() => null),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/constants/providers', () => ({
  predefinedProviders: [
    {
      provider: 'openai',
      active: false,
      base_url: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4', name: 'GPT-4' }],
    },
  ],
}))

vi.mock('@/constants/models', () => ({
  providerModels: {
    openai: {
      models: ['gpt-4', 'gpt-3.5-turbo'],
    },
  },
}))

vi.mock('@janhq/core', () => ({
  EngineManager: {
    instance: vi.fn(),
  },
  SettingComponentProps: {},
}))

vi.mock('@/types/models', () => ({
  ModelCapabilities: {
    TOOLS: 'tools',
    EMBEDDINGS: 'embeddings',
  },
}))

vi.mock('@/lib/predefined', () => ({
  modelSettings: {
    temperature: {
      key: 'temperature',
      controller_props: { value: 0.7 },
    },
    ctx_len: {
      key: 'ctx_len',
      controller_props: { value: 4096 },
    },
  },
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: vi.fn(),
  },
}))

vi.mock('@/lib/models', () => ({
  getModelCapabilities: vi.fn().mockReturnValue([]),
}))

vi.mock('@/lib/provider-api-keys', () => ({
  providerRemoteApiKeyChain: vi.fn().mockReturnValue([]),
  API_KEY_FALLBACKS_SETTING_KEY: 'api-key-fallbacks',
}))

import { providerFetch as fetchTauri } from '@/lib/providerFetch'
import { invoke } from '@tauri-apps/api/core'
import { EngineManager } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { TauriProvidersService } from '../tauri'

describe('TauriProvidersService', () => {
  let svc: TauriProvidersService

  beforeEach(() => {
    vi.clearAllMocks()
    svc = new TauriProvidersService()
  })

  describe('fetch', () => {
    it('returns Tauri fetch', () => {
      expect(svc.fetch()).toBe(fetchTauri)
    })
  })

  describe('getProviders', () => {
    it('returns builtin + runtime providers on success', async () => {
      const mockEngine = {
        list: vi.fn().mockResolvedValue([
          { id: 'local-model', name: 'Local', description: 'desc' },
        ]),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockResolvedValue(false),
        inferenceUrl: 'http://localhost:1337/chat/completions',
      }
      vi.mocked(EngineManager.instance).mockReturnValue({
        engines: new Map([['llama.cpp', mockEngine]]),
      } as any)

      const result = await svc.getProviders()
      expect(result.length).toBeGreaterThan(0)
      // Runtime provider first, then builtins
      const llama = result.find((p: any) => p.provider === 'llama.cpp')
      expect(llama).toBeDefined()
      expect(llama!.models).toHaveLength(1)
    })

    it('adds TOOLS capability when isToolSupported returns true', async () => {
      const mockEngine = {
        list: vi.fn().mockResolvedValue([{ id: 'm1', name: 'M1', description: '' }]),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockResolvedValue(true),
        inferenceUrl: 'http://localhost:1337/chat/completions',
      }
      vi.mocked(EngineManager.instance).mockReturnValue({
        engines: new Map([['test-engine', mockEngine]]),
      } as any)

      const result = await svc.getProviders()
      const provider = result.find((p: any) => p.provider === 'test-engine')
      expect(provider!.models[0].capabilities).toContain('tools')
    })

    it('adds EMBEDDINGS capability for embedding models', async () => {
      const mockEngine = {
        list: vi.fn().mockResolvedValue([{ id: 'emb', name: 'Emb', description: '', embedding: true }]),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockResolvedValue(false),
        inferenceUrl: 'http://localhost:1337/chat/completions',
      }
      vi.mocked(EngineManager.instance).mockReturnValue({
        engines: new Map([['emb-engine', mockEngine]]),
      } as any)

      const result = await svc.getProviders()
      const provider = result.find((p: any) => p.provider === 'emb-engine')
      expect(provider!.models[0].capabilities).toContain('embeddings')
    })

    it('warns but continues when isToolSupported throws', async () => {
      const mockEngine = {
        list: vi.fn().mockResolvedValue([{ id: 'm1', name: 'M1', description: '' }]),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockRejectedValue(new Error('fail')),
        inferenceUrl: 'http://localhost:1337/chat/completions',
      }
      vi.mocked(EngineManager.instance).mockReturnValue({
        engines: new Map([['test-engine', mockEngine]]),
      } as any)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await svc.getProviders()
      expect(result.find((p: any) => p.provider === 'test-engine')).toBeDefined()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('keeps the other providers when one engine fails to list', async () => {
      const good = {
        list: vi.fn().mockResolvedValue([{ id: 'm1', name: 'M1', description: '' }]),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockResolvedValue(false),
      }
      const bad = {
        list: vi.fn().mockRejectedValue(new Error('engine down')),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockResolvedValue(false),
      }
      vi.mocked(EngineManager.instance).mockReturnValue({
        engines: new Map([
          ['bad-engine', bad],
          ['good-engine', good],
        ]),
      } as any)
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = await svc.getProviders()
      expect(result.find((p: any) => p.provider === 'good-engine')).toBeDefined()
      expect(result.find((p: any) => p.provider === 'bad-engine')).toBeUndefined()
      expect(result.find((p: any) => p.provider === 'openai')).toBeDefined()
      errSpy.mockRestore()
    })

    it('lists engines side by side and keeps their order (HKS-034)', async () => {
      let releaseSlow: () => void = () => {}
      const slow = {
        list: vi.fn(() => new Promise((r) => (releaseSlow = () => r([])))),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockResolvedValue(false),
      }
      const fast = {
        list: vi.fn().mockResolvedValue([]),
        getSettings: vi.fn().mockResolvedValue([]),
        isToolSupported: vi.fn().mockResolvedValue(false),
      }
      vi.mocked(EngineManager.instance).mockReturnValue({
        engines: new Map([
          ['slow-engine', slow],
          ['fast-engine', fast],
        ]),
      } as any)
      const pending = svc.getProviders()
      await Promise.resolve()
      // The second engine is asked before the first has answered.
      expect(fast.list).toHaveBeenCalled()
      releaseSlow()
      const names = (await pending).map((p: any) => p.provider)
      expect(names.indexOf('slow-engine')).toBeLessThan(names.indexOf('fast-engine'))
      expect(names.indexOf('slow-engine')).toBe(0)
    })

    it('returns empty array on top-level error', async () => {
      vi.mocked(EngineManager.instance).mockImplementation(() => {
        throw new Error('boom')
      })
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = await svc.getProviders()
      expect(result).toEqual([])
      errSpy.mockRestore()
    })

    it('maps engine settings correctly', async () => {
      const mockEngine = {
        list: vi.fn().mockResolvedValue([]),
        getSettings: vi.fn().mockResolvedValue([
          { key: 'api_key', title: 'API Key', description: 'Key', controllerType: 'input', controllerProps: {} },
        ]),
        inferenceUrl: 'http://localhost:1337/chat/completions',
      }
      vi.mocked(EngineManager.instance).mockReturnValue({
        engines: new Map([['test', mockEngine]]),
      } as any)

      const result = await svc.getProviders()
      const provider = result.find((p: any) => p.provider === 'test')
      expect(provider!.settings).toEqual([
        { key: 'api_key', title: 'API Key', description: 'Key', controller_type: 'input', controller_props: {} },
      ])
    })
  })

  describe('fetchModelsFromProvider', () => {
    const baseProvider = {
      provider: 'test-provider',
      base_url: 'https://api.test.com/v1',
      active: false,
    } as any

    it('throws if no base_url', async () => {
      await expect(svc.fetchModelsFromProvider({ ...baseProvider, base_url: '' }))
        .rejects.toThrow('Provider must have base_url configured')
    })

    it('returns model ids from data.data format', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [{ id: 'model-1' }, { id: 'model-2' }] }),
      } as any)

      const result = await svc.fetchModelsFromProvider(baseProvider)
      expect(result).toEqual(['model-1', 'model-2'])
    })

    it('lists an Azure deployments endpoint with api-key and api-version', async () => {
      vi.mocked(providerRemoteApiKeyChain).mockReturnValueOnce(['az-key'])
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [{ id: 'gpt' }] }),
      } as any)
      await svc.fetchModelsFromProvider({
        provider: 'azure',
        base_url: 'https://r.openai.azure.com/openai/deployments/qa',
        active: true,
        settings: [
          { key: 'api-version', controller_props: { value: '2024-10-21' } },
        ],
      } as any)
      const [url, init] = vi.mocked(fetchTauri).mock.calls[0] as [string, any]
      expect(url).toBe(
        'https://r.openai.azure.com/openai/deployments/qa/models?api-version=2024-10-21'
      )
      expect(init.headers['api-key']).toBe('az-key')
    })

    it('returns each model id once when listed twice', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }],
        }),
      } as any)
      expect(await svc.fetchModelsFromProvider(baseProvider)).toEqual(['a', 'b'])
    })

    it('returns model ids from array format', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]),
      } as any)

      const result = await svc.fetchModelsFromProvider(baseProvider)
      expect(result).toEqual(['a', 'b'])
    })

    it('returns model ids from data.models format', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ models: ['m1', 'm2'] }),
      } as any)

      const result = await svc.fetchModelsFromProvider(baseProvider)
      expect(result).toEqual(['m1', 'm2'])
    })

    it('returns empty for unexpected format', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ unexpected: true }),
      } as any)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await svc.fetchModelsFromProvider(baseProvider)
      expect(result).toEqual([])
      warnSpy.mockRestore()
    })

    it('throws structured error on 401', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as any)

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.fetchModelsFromProvider(baseProvider))
        .rejects.toThrow(/test-provider.*https:\/\/api\.test\.com\/v1\/models.*401/s)
      errSpy.mockRestore()
    })

    it('throws structured error on 403', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      } as any)

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.fetchModelsFromProvider(baseProvider))
        .rejects.toThrow(/test-provider.*https:\/\/api\.test\.com\/v1\/models.*403/s)
      errSpy.mockRestore()
    })

    it('throws structured error on 404', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as any)

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.fetchModelsFromProvider(baseProvider))
        .rejects.toThrow(/test-provider.*404.*ends at \/v1/s)
      errSpy.mockRestore()
    })

    it('names the provider, endpoint and status on other status codes', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      } as any)

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.fetchModelsFromProvider(baseProvider))
        .rejects.toThrow(/test-provider.*500.*check its logs/s)
      errSpy.mockRestore()
    })

    it('names the endpoint it could not reach, not just the provider', async () => {
      vi.mocked(fetchTauri).mockRejectedValueOnce(new Error('fetch failed'))

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.fetchModelsFromProvider(baseProvider)).rejects.toThrow(
        /test-provider.*could not reach GET https:\/\/api\.test\.com\/v1\/models/s
      )
      errSpy.mockRestore()
    })

    it("keeps the transport's own diagnosis instead of burying it", async () => {
      // What a short hostname resolving to the wrong machine actually looks
      // like. The resolution detail is the whole answer, and wrapping it in
      // "Unexpected error while fetching models from X" read as a fault in
      // Jan rather than an endpoint that was not listening.
      // Not `Once`: this asserts twice, and a second call falling through to
      // a different mock would be testing something else.
      vi.mocked(fetchTauri).mockRejectedValue(
        new Error(
          'llm-host:8555 could not connect (resolved 203.0.113.9 [public, suppressed], 127.0.0.1 [loopback]; selected 127.0.0.1)'
        )
      )

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.fetchModelsFromProvider(baseProvider)).rejects.toThrow(
        /203\.0\.113\.9 \[public, suppressed\]/
      )
      await expect(
        svc.fetchModelsFromProvider(baseProvider)
      ).rejects.not.toThrow(/Unexpected error/)
      errSpy.mockRestore()
    })

    it('adds Origin header for localhost URLs', async () => {
      const localProvider = { ...baseProvider, base_url: 'http://localhost:1234' }
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider(localProvider)
      expect(fetchTauri).toHaveBeenCalledWith(
        'http://localhost:1234/models',
        expect.objectContaining({
          headers: expect.objectContaining({ Origin: 'tauri://localhost' }),
        })
      )
    })

    it('adds only Authorization for an OpenAI-compatible provider', async () => {
      vi.mocked(providerRemoteApiKeyChain).mockReturnValue(['sk-test'])
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider(baseProvider)
      expect(fetchTauri).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
          }),
        })
      )
      const sent = vi.mocked(fetchTauri).mock.calls[0][1] as {
        headers: Record<string, string>
      }
      expect(sent.headers).not.toHaveProperty('x-api-key')
    })

    it('adds only x-api-key for an Anthropic provider', async () => {
      vi.mocked(providerRemoteApiKeyChain).mockReturnValue(['sk-ant'])
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider({
        ...baseProvider,
        api_type: 'anthropic',
      } as any)
      const sent = vi.mocked(fetchTauri).mock.calls[0][1] as {
        headers: Record<string, string>
      }
      expect(sent.headers['x-api-key']).toBe('sk-ant')
      expect(sent.headers).not.toHaveProperty('Authorization')
    })

    it('adds default anthropic-version header for anthropic-shaped custom providers', async () => {
      const provider = {
        ...baseProvider,
        provider: 'anthropic',
        base_url: 'https://anthropic.example.com/v1',
      }
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider(provider)
      expect(fetchTauri).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
        })
      )
    })

    it('adds default anthropic-version header when api_type is anthropic despite non-anthropic name/host', async () => {
      const provider = {
        ...baseProvider,
        provider: 'my-gateway',
        base_url: 'https://gateway.corp.com/v1',
        api_type: 'anthropic',
      }
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider(provider)
      expect(fetchTauri).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          }),
        })
      )
    })

    it('does not add anthropic-version for non-anthropic providers', async () => {
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider(baseProvider)
      const headers = vi.mocked(fetchTauri).mock.calls[0][1]?.headers as Record<
        string,
        string
      >
      expect(headers).not.toHaveProperty('anthropic-version')
      expect(headers).not.toHaveProperty(
        'anthropic-dangerous-direct-browser-access'
      )
    })

    it('does not override a caller-supplied anthropic-version', async () => {
      const provider = {
        ...baseProvider,
        provider: 'anthropic_proxy',
        custom_header: [{ header: 'anthropic-version', value: '2099-01-01' }],
      }
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider(provider)
      expect(fetchTauri).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'anthropic-version': '2099-01-01' }),
        })
      )
    })

    it('retries with next key on 401 and succeeds', async () => {
      vi.mocked(providerRemoteApiKeyChain).mockReturnValue(['bad-key', 'good-key'])
      vi.mocked(fetchTauri)
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauth' } as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({ data: [{ id: 'x' }] }),
        } as any)

      const result = await svc.fetchModelsFromProvider(baseProvider)
      expect(result).toEqual(['x'])
      expect(fetchTauri).toHaveBeenCalledTimes(2)
    })

    it('applies custom headers from provider', async () => {
      const customProvider = {
        ...baseProvider,
        custom_header: [{ header: 'X-Custom', value: 'val' }],
      }
      vi.mocked(fetchTauri).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as any)

      await svc.fetchModelsFromProvider(customProvider)
      expect(fetchTauri).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Custom': 'val' }),
        })
      )
    })
  })

  describe('fetchModelEntry', () => {
    it('tries the next address when the first one fails to connect', async () => {
      const ok = {
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'm1', context_length: 8 }] }),
      }
      vi.mocked(fetchTauri)
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValueOnce(ok as unknown as Response)
      const entry = await svc.fetchModelEntry(
        { provider: 'x', base_url: 'http://host:8000', models: [] } as never,
        'm1'
      )
      expect(entry).toMatchObject({ id: 'm1' })
      expect(fetchTauri).toHaveBeenCalledTimes(2)
    })
  })

  describe('updateSettings', () => {
    it('delegates to engine updateSettings', async () => {
      const mockUpdate = vi.fn()
      vi.mocked(ExtensionManager.getInstance).mockReturnValue({
        getEngine: vi.fn().mockReturnValue({ updateSettings: mockUpdate }),
      } as any)

      await svc.updateSettings('test', [
        { key: 'k', controller_type: 'input', controller_props: { value: 'v' } } as any,
      ])

      expect(mockUpdate).toHaveBeenCalledWith([
        expect.objectContaining({
          key: 'k',
          controllerType: 'input',
          controllerProps: { value: 'v' },
        }),
      ])
    })

    it('defaults value to empty string when undefined', async () => {
      const mockUpdate = vi.fn()
      vi.mocked(ExtensionManager.getInstance).mockReturnValue({
        getEngine: vi.fn().mockReturnValue({ updateSettings: mockUpdate }),
      } as any)

      await svc.updateSettings('test', [
        { key: 'k', controller_type: 'input', controller_props: {} } as any,
      ])

      expect(mockUpdate).toHaveBeenCalledWith([
        expect.objectContaining({
          controllerProps: { value: '' },
        }),
      ])
    })

    it('blanks api-key and api-key-fallbacks so keys never reach settings.json', async () => {
      const mockUpdate = vi.fn()
      vi.mocked(ExtensionManager.getInstance).mockReturnValue({
        getEngine: vi.fn().mockReturnValue({ updateSettings: mockUpdate }),
      } as any)

      await svc.updateSettings('openai', [
        { key: 'api-key', controller_type: 'input', controller_props: { value: 'sk-secret' } } as any,
        { key: 'api-key-fallbacks', controller_type: 'input', controller_props: { value: 'sk-a\nsk-b' } } as any,
        { key: 'base-url', controller_type: 'input', controller_props: { value: 'https://x' } } as any,
      ])

      const persisted = mockUpdate.mock.calls[0][0]
      expect(persisted.find((s: any) => s.key === 'api-key').controllerProps.value).toBe('')
      expect(persisted.find((s: any) => s.key === 'api-key-fallbacks').controllerProps.value).toBe('')
      expect(persisted.find((s: any) => s.key === 'base-url').controllerProps.value).toBe('https://x')
    })

    it('rethrows on error', async () => {
      vi.mocked(ExtensionManager.getInstance).mockReturnValue({
        getEngine: vi.fn().mockReturnValue({
          updateSettings: vi.fn().mockRejectedValue(new Error('fail')),
        }),
      } as any)

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.updateSettings('test', [])).rejects.toThrow('fail')
      errSpy.mockRestore()
    })
  })

  describe('deleteProviderKeys', () => {
    it('invokes delete_provider_keys with the provider name', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(undefined)
      await svc.deleteProviderKeys('openai')
      expect(invoke).toHaveBeenCalledWith('delete_provider_keys', {
        provider: 'openai',
      })
    })

    it('swallows and logs errors so a failed delete never throws', async () => {
      vi.mocked(invoke).mockRejectedValueOnce(new Error('keyring down'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(svc.deleteProviderKeys('openai')).resolves.toBeUndefined()
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })
})
