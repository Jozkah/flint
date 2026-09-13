import { describe, expect, it } from 'vitest'
import {
  deriveModelStatus,
  modelStatusLabelKey,
  modelStatusTone,
  type ModelStatus,
} from '@/lib/modelStatus'

describe('deriveModelStatus', () => {
  describe('engine-managed models', () => {
    const base = { modelId: 'qwen', engineManaged: true }

    it('is available when nothing else is known', () => {
      expect(deriveModelStatus(base)).toBe('available')
      expect(deriveModelStatus({ ...base, activeModels: ['other'] })).toBe(
        'available'
      )
    })

    it('is loaded when the engine lists it', () => {
      expect(deriveModelStatus({ ...base, activeModels: ['qwen'] })).toBe(
        'loaded'
      )
    })

    it('is loading while a load is in flight, even if a previous load is listed', () => {
      expect(
        deriveModelStatus({
          ...base,
          activeModels: ['qwen'],
          loadingModelIds: ['qwen'],
        })
      ).toBe('loading')
    })

    it('is failed when its last load failed and it is not loaded', () => {
      expect(deriveModelStatus({ ...base, failedModelIds: ['qwen'] })).toBe(
        'failed'
      )
    })

    it('does not claim a failure for a model that is loaded now', () => {
      expect(
        deriveModelStatus({
          ...base,
          activeModels: ['qwen'],
          failedModelIds: ['qwen'],
        })
      ).toBe('loaded')
    })

    it('a failure of another model does not mark this one', () => {
      expect(deriveModelStatus({ ...base, failedModelIds: ['llama'] })).toBe(
        'available'
      )
    })

    it('ignores remote-only facts', () => {
      expect(
        deriveModelStatus({
          ...base,
          apiKeyMissing: true,
          connectionVerified: true,
        })
      ).toBe('available')
    })
  })

  describe('remote models', () => {
    const base = { modelId: 'gpt-4', engineManaged: false }

    it('shows no status when nothing is known', () => {
      expect(deriveModelStatus(base)).toBeNull()
    })

    it('needs an API key when the endpoint is remote and none is saved', () => {
      expect(deriveModelStatus({ ...base, apiKeyMissing: true })).toBe(
        'needs-api-key'
      )
    })

    it('is connected only after a request succeeded', () => {
      expect(deriveModelStatus({ ...base, connectionVerified: true })).toBe(
        'connected'
      )
    })

    it('a missing key outranks an earlier success', () => {
      expect(
        deriveModelStatus({
          ...base,
          apiKeyMissing: true,
          connectionVerified: true,
        })
      ).toBe('needs-api-key')
    })

    it('never reports an engine state for a remote model', () => {
      expect(
        deriveModelStatus({
          ...base,
          activeModels: ['gpt-4'],
          loadingModelIds: ['gpt-4'],
          failedModelIds: ['gpt-4'],
        })
      ).toBeNull()
    })
  })
})

describe('status presentation', () => {
  const all: ModelStatus[] = [
    'loading',
    'loaded',
    'failed',
    'available',
    'needs-api-key',
    'connected',
  ]

  it('gives every status a tone and a providers: label key', () => {
    for (const status of all) {
      expect(modelStatusTone(status)).toBeTruthy()
      expect(modelStatusLabelKey(status)).toMatch(/^providers:status\./)
    }
  })

  it('draws failures as destructive and loaded models as success', () => {
    expect(modelStatusTone('failed')).toBe('destructive')
    expect(modelStatusTone('loaded')).toBe('success')
    expect(modelStatusTone('needs-api-key')).toBe('warning')
    expect(modelStatusTone('available')).toBe('neutral')
  })
})
