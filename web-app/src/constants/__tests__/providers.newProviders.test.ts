import { describe, expect, it } from 'vitest'
import { predefinedProviders } from '@/constants/providers'
import { providerModels } from '@/constants/models'
import { getProviderTitle } from '@/lib/utils'

const NEW = ['deepseek', 'moonshot', 'cohere', 'perplexity', 'together', 'fireworks', 'cerebras', 'sambanova', 'zai', 'qwen']

describe('hosted providers', () => {
  it('lists every provider once', () => {
    const ids = predefinedProviders.map((p) => p.provider)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of NEW) expect(ids).toContain(id)
  })

  it.each(NEW)('%s has an https endpoint, an API key field and a readable name', (id) => {
    const p = predefinedProviders.find((e) => e.provider === id)!
    expect(p.base_url).toMatch(/^https:\/\//)
    expect(p.settings.some((s) => s.key === 'api-key')).toBe(true)
    expect(p.explore_models_url).toMatch(/^https:\/\//)
    expect(getProviderTitle(id)).not.toBe(id)
  })

  it('only the region-bound provider lets the endpoint be edited', () => {
    const editable = predefinedProviders.filter((p) => p.settings.some((s) => s.key === 'base-url')).map((p) => p.provider)
    for (const id of NEW) expect(editable.includes(id)).toBe(id === 'qwen')
  })

  it('give each listed model a place in the capability table', () => {
    for (const id of ['deepseek', 'moonshot', 'together', 'fireworks', 'cerebras', 'sambanova', 'zai', 'qwen']) {
      const models = providerModels[id as keyof typeof providerModels].models as readonly string[]
      expect(models.length).toBeGreaterThan(0)
    }
  })
})
