import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DefaultModelsService } from '../models/default'
import type { HuggingFaceRepo, CatalogModel } from '../models/types'
import { EngineManager, events, DownloadEvent } from '@janhq/core'

const { mockEvents, mockDownloadEvent } = vi.hoisted(() => ({
  mockEvents: { emit: vi.fn() },
  mockDownloadEvent: { onFileDownloadStopped: 'onFileDownloadStopped' } as Record<string, string>,
}))

vi.mock('@janhq/core', () => ({
  EngineManager: { instance: vi.fn() },
  events: mockEvents,
  DownloadEvent: mockDownloadEvent,
}))

global.fetch = vi.fn()


describe('DefaultModelsService', () => {
  let modelsService: DefaultModelsService

  const mockEngine = {
    list: vi.fn(),
    updateSettings: vi.fn(),
    update: vi.fn(),
    import: vi.fn(),
    abortImport: vi.fn(),
    delete: vi.fn(),
    getLoadedModels: vi.fn(),
    unload: vi.fn(),
    load: vi.fn(),
    isModelSupported: vi.fn(),
    isToolSupported: vi.fn(),
    checkMmprojExists: vi.fn(),
    getMtpInfo: vi.fn(),
    updateMtpSettings: vi.fn(),
  }

  const mockEngineManager = { get: vi.fn().mockReturnValue(mockEngine) }

  beforeEach(() => {
    modelsService = new DefaultModelsService()
    vi.clearAllMocks()
    ;(EngineManager.instance as any).mockReturnValue(mockEngineManager)
    mockEvents.emit.mockClear()
  })

  describe('fetchModels', () => {
    it('should fetch models successfully', async () => {
      const mockModels = [{ id: 'model1' }, { id: 'model2' }]
      mockEngine.list.mockResolvedValue(mockModels)
      expect(await modelsService.fetchModels()).toEqual(mockModels)
    })
  })

  describe('updateModel', () => {
    it.each([
      ['with settings', { id: 'model1', settings: [{ key: 'temp', value: 0.7 }] }, true],
      ['without settings', { id: 'model1' }, false],
      ['with different modelId', { id: 'new-id', settings: [{ key: 'temp', value: 0.7 }] }, true],
    ])('should handle model %s', async (_label, model, expectSettings) => {
      await modelsService.updateModel('model1', model as any)
      if (expectSettings) {
        expect(mockEngine.updateSettings).toHaveBeenCalledWith(model.settings)
      } else {
        expect(mockEngine.updateSettings).not.toHaveBeenCalled()
      }
      expect(mockEngine.update).not.toHaveBeenCalled()
    })
  })

  describe('pullModel', () => {
    it('should pull model successfully', async () => {
      await modelsService.pullModel('model1', '/path/to/model')
      expect(mockEngine.import).toHaveBeenCalledWith('model1', { modelPath: '/path/to/model' })
    })
  })

  describe('deleteModel', () => {
    it('should delete model', async () => {
      await modelsService.deleteModel('model1')
      expect(mockEngine.delete).toHaveBeenCalledWith('model1')
    })
  })

  describe('getActiveModels', () => {
    it('should get active models', async () => {
      mockEngine.getLoadedModels.mockResolvedValue(['model1', 'model2'])
      expect(await modelsService.getActiveModels()).toEqual(['model1', 'model2'])
    })
  })

  describe('stopModel / stopAllModels', () => {
    it('should stop model', async () => {
      await modelsService.stopModel('model1', 'openai')
      expect(mockEngine.unload).toHaveBeenCalledWith('model1')
    })

    it('should stop all active models from all providers', async () => {
      mockEngine.getLoadedModels.mockResolvedValue(['model1', 'model2'])
      await modelsService.stopAllModels()
      expect(mockEngine.unload).toHaveBeenCalledTimes(4)
    })

    it('should handle empty active models', async () => {
      mockEngine.getLoadedModels.mockResolvedValue(null)
      await modelsService.stopAllModels()
      expect(mockEngine.unload).not.toHaveBeenCalled()
    })
  })

  describe('startModel', () => {
    const makeProvider = (settings?: any) => ({
      provider: 'openai',
      models: [{ id: 'model1', settings }],
    }) as any

    const mockSettings = {
      ctx_len: { controller_props: { value: 4096 } },
      ngl: { controller_props: { value: 32 } },
    }

    it('should start model successfully', async () => {
      mockEngine.getLoadedModels.mockResolvedValue({ includes: () => false })
      mockEngine.load.mockResolvedValue({ id: 'session1' })
      const result = await modelsService.startModel(makeProvider(mockSettings), 'model1')
      expect(result).toEqual({ id: 'session1' })
      expect(mockEngine.load).toHaveBeenCalledWith('model1', { ctx_size: 4096, n_gpu_layers: 32 }, false, false)
    })

    it('should handle start model error', async () => {
      mockEngine.getLoadedModels.mockResolvedValue({ includes: () => false })
      mockEngine.load.mockRejectedValue(new Error('Failed'))
      await expect(modelsService.startModel(makeProvider(mockSettings), 'model1')).rejects.toThrow('Failed')
    })

    it('should not load already-loaded model', async () => {
      mockEngine.getLoadedModels.mockResolvedValue({ includes: () => true })
      await expect(modelsService.startModel(makeProvider(mockSettings), 'model1')).resolves.toBe(undefined)
      expect(mockEngine.load).not.toHaveBeenCalled()
    })
  })

  describe('isModelSupported', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it.each([
      ['GREEN', 'GREEN', '/path/model.gguf', 4096],
      ['YELLOW', 'YELLOW', '/path/model.gguf', 8192],
      ['RED', 'RED', '/path/large.gguf', undefined],
    ])('should return %s when engine says %s', async (_label, expected, path, ctxLen) => {
      const eng = { ...mockEngine, isModelSupported: vi.fn().mockResolvedValue(expected) }
      mockEngineManager.get.mockReturnValue(eng)
      expect(await modelsService.isModelSupported(path, ctxLen)).toBe(expected)
      expect(eng.isModelSupported).toHaveBeenCalledWith(path, ctxLen)
    })

    it('should return YELLOW when engine method is not available', async () => {
      mockEngineManager.get.mockReturnValue({ ...mockEngine, isModelSupported: undefined })
      expect(await modelsService.isModelSupported('/path/model.gguf')).toBe('YELLOW')
    })

    it('should return YELLOW when engine is null', async () => {
      mockEngineManager.get.mockReturnValue(null)
      expect(await modelsService.isModelSupported('/path/model.gguf')).toBe('YELLOW')
    })

    it('should return GREY on error', async () => {
      const eng = { ...mockEngine, isModelSupported: vi.fn().mockRejectedValue(new Error('err')) }
      mockEngineManager.get.mockReturnValue(eng)
      expect(await modelsService.isModelSupported('/path/model.gguf')).toBe('GREY')
    })
  })
})
