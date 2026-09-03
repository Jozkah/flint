import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DefaultModelsService } from '../default'
import { EngineManager, events, DownloadEvent, ContentType } from '@janhq/core'

const { mockEvents } = vi.hoisted(() => ({
  mockEvents: { emit: vi.fn() },
}))

vi.mock('@janhq/core', () => ({
  EngineManager: { instance: vi.fn() },
  events: mockEvents,
  DownloadEvent: {
    onFileDownloadStopped: 'onFileDownloadStopped',
    onFileDownloadError: 'onFileDownloadError',
  },
  ContentType: { Text: 'text', Image: 'image_url' },
}))

vi.mock('@/lib/utils', () => ({
  sanitizeModelId: (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, '_'),
}))

vi.mock('../tokenCountToolContext', () => ({
  extractToolContextFromContent: vi.fn().mockReturnValue(''),
  extractToolContextFromMetadata: vi.fn().mockReturnValue(''),
}))

global.fetch = vi.fn()

Object.defineProperty(global, 'MODEL_CATALOG_URL', {
  value: 'https://example.com/models',
  writable: true,
  configurable: true,
})
Object.defineProperty(global, 'LATEST_JAN_MODEL_URL', {
  value: 'https://example.com/latest',
  writable: true,
  configurable: true,
})

describe('DefaultModelsService - coverage supplement', () => {
  let svc: DefaultModelsService

  const mockEngine = {
    get: vi.fn(),
    list: vi.fn(),
    updateSettings: vi.fn(),
    import: vi.fn(),
    abortImport: vi.fn(),
    delete: vi.fn(),
    getLoadedModels: vi.fn(),
    unload: vi.fn(),
    load: vi.fn(),
    isModelSupported: vi.fn(),
    isToolSupported: vi.fn(),
    checkMmprojExists: vi.fn(),
    validateGgufFile: vi.fn(),
    getTokensCount: vi.fn(),
  }

  const mockEngineManager = {
    get: vi.fn().mockReturnValue(mockEngine),
  }

  beforeEach(() => {
    svc = new DefaultModelsService()
    vi.clearAllMocks()
    ;(EngineManager.instance as any).mockReturnValue(mockEngineManager)
    mockEngineManager.get.mockReturnValue(mockEngine)
  })

  // ── fetchModelCatalog ──
  // ── fetchHuggingFaceRepo ──
  // ── convertHfRepoToCatalogModel ──
  // ── updateModel ──
  describe('updateModel', () => {
    it('calls engine updateSettings when model has settings', async () => {
      await svc.updateModel('m1', { settings: [{ key: 'ctx_len' }] } as any)
      expect(mockEngine.updateSettings).toHaveBeenCalled()
    })

    it('does not call updateSettings when no settings', async () => {
      await svc.updateModel('m1', { name: 'new-name' } as any)
      expect(mockEngine.updateSettings).not.toHaveBeenCalled()
    })
  })

  // ── fetchModels ──
  describe('fetchModels', () => {
    it('returns list from engine', async () => {
      mockEngine.list.mockReturnValue([{ id: 'm1' }])
      const result = await svc.fetchModels()
      expect(result).toEqual([{ id: 'm1' }])
    })
  })

  // ── stopAllModels ──
  describe('stopAllModels', () => {
    it('stops all llamacpp and mlx models', async () => {
      mockEngineManager.get.mockImplementation((provider: string) => {
        if (provider === 'llamacpp') return { ...mockEngine, getLoadedModels: vi.fn().mockResolvedValue(['m1']), unload: vi.fn() }
        if (provider === 'mlx') return { ...mockEngine, getLoadedModels: vi.fn().mockResolvedValue(['m2']), unload: vi.fn() }
        return mockEngine
      })

      await svc.stopAllModels()
      // Just verify it doesn't throw
    })

    it('handles empty model lists', async () => {
      mockEngine.getLoadedModels.mockResolvedValue([])
      await svc.stopAllModels()
    })
  })

  // ── isModelSupported ──
  describe('isModelSupported', () => {
    it('returns result from engine', async () => {
      mockEngine.isModelSupported.mockResolvedValue('GREEN')
      const result = await svc.isModelSupported('/path/model.gguf', 4096)
      expect(result).toBe('GREEN')
    })

    it('returns YELLOW when method not available', async () => {
      mockEngineManager.get.mockReturnValueOnce({})
      const result = await svc.isModelSupported('/path/model.gguf')
      expect(result).toBe('YELLOW')
    })

    it('returns GREY on error', async () => {
      mockEngine.isModelSupported.mockRejectedValue(new Error('fail'))
      const result = await svc.isModelSupported('/path/model.gguf')
      expect(result).toBe('GREY')
    })
  })

  // ── startModel with settings mapping ──
  describe('startModel with settings', () => {
    it('maps ctx_len to ctx_size and ngl to n_gpu_layers', async () => {
      mockEngine.getLoadedModels.mockResolvedValue([])
      mockEngine.load.mockResolvedValue({ id: 'session' })

      const provider = {
        provider: 'llamacpp',
        models: [{
          id: 'm1',
          settings: {
            ctx_len: { key: 'ctx_len', controller_props: { value: 4096 } },
            ngl: { key: 'ngl', controller_props: { value: 33 } },
            custom: { key: 'custom', controller_props: { value: 'val' } },
          },
        }],
      } as any

      await svc.startModel(provider, 'm1')
      expect(mockEngine.load).toHaveBeenCalledWith(
        'm1',
        { ctx_size: 4096, n_gpu_layers: 33, custom: 'val' },
        false,
        false
      )
    })

    it('returns undefined when model already loaded', async () => {
      mockEngine.getLoadedModels.mockResolvedValue(['m1'])
      const result = await svc.startModel(
        { provider: 'llamacpp', models: [] } as any,
        'm1'
      )
      expect(result).toBeUndefined()
      expect(mockEngine.load).not.toHaveBeenCalled()
    })

    it('throws on load failure', async () => {
      mockEngine.getLoadedModels.mockResolvedValue([])
      mockEngine.load.mockRejectedValue(new Error('load fail'))

      await expect(
        svc.startModel({ provider: 'llamacpp', models: [] } as any, 'm1')
      ).rejects.toThrow('load fail')
    })
  })

  // ── abortDownload ──
  // ── getActiveModels ──
  describe('getActiveModels', () => {
    it('returns loaded models', async () => {
      mockEngine.getLoadedModels.mockResolvedValue(['m1', 'm2'])
      const result = await svc.getActiveModels('llamacpp')
      expect(result).toEqual(['m1', 'm2'])
    })

    it('returns empty when no engine', async () => {
      mockEngineManager.get.mockReturnValueOnce(undefined)
      const result = await svc.getActiveModels('unknown')
      expect(result).toEqual([])
    })
  })

  // ── stopModel ──
  describe('stopModel', () => {
    it('calls engine unload', async () => {
      mockEngine.unload.mockResolvedValue({ ok: true })
      const result = await svc.stopModel('m1', 'llamacpp')
      expect(result).toEqual({ ok: true })
    })
  })

  // ── pullModel with no engine ──
  describe('pullModel', () => {
    it('returns undefined when no engine', async () => {
      mockEngineManager.get.mockReturnValueOnce(undefined)
      const result = await svc.pullModel('id1', '/path')
      expect(result).toBeUndefined()
    })
  })
})
