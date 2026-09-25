import { describe, it, expect } from 'vitest'
import { getMutualExclusionDrops, isModelLevelRejected } from '../providerCaps'

const SAMPLERS = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
] as const

/** The sampler keys a model rejects, as a sorted list for exact comparison. */
const rejected = (providerId: string, modelId: string) =>
  SAMPLERS.filter((key) => isModelLevelRejected(key, providerId, modelId))

describe('getMutualExclusionDrops', () => {
  it('drops top_p when anthropic gets both temperature and top_p', () => {
    expect(
      getMutualExclusionDrops({ temperature: 0.7, top_p: 0.9 }, 'anthropic')
    ).toEqual(new Set(['top_p']))
  })

  it('applies to any provider speaking the anthropic api type', () => {
    expect(
      getMutualExclusionDrops(
        { temperature: 0.7, top_p: 0.9 },
        'my-proxy',
        'anthropic'
      )
    ).toEqual(new Set(['top_p']))
  })

  it('drops nothing when only one of the pair is set', () => {
    expect(getMutualExclusionDrops({ temperature: 0.7 }, 'anthropic').size).toBe(0)
    expect(getMutualExclusionDrops({ top_p: 0.9 }, 'anthropic').size).toBe(0)
  })

  it('drops nothing for openai-shaped providers', () => {
    expect(
      getMutualExclusionDrops({ temperature: 0.7, top_p: 0.9 }, 'openai')
    ).toEqual(new Set())
    expect(
      getMutualExclusionDrops(
        { temperature: 0.7, top_p: 0.9 },
        'custom',
        'openai'
      )
    ).toEqual(new Set())
  })
})

describe('isModelLevelRejected', () => {
  it.each(['o1', 'o1-preview', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt5-mini', 'GPT-5.1'])(
    'rejects every sampler for openai/azure reasoning model %s',
    (modelId) => {
      expect(rejected('openai', modelId)).toEqual([...SAMPLERS])
      expect(rejected('azure', modelId)).toEqual([...SAMPLERS])
    }
  )

  it.each(['gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo', 'omni-moderation'])(
    'accepts every sampler for non-reasoning openai model %s',
    (modelId) => {
      expect(rejected('openai', modelId)).toEqual([])
      expect(rejected('azure', modelId)).toEqual([])
    }
  )

  it('never rejects unrelated keys on reasoning models', () => {
    expect(isModelLevelRejected('max_tokens', 'openai', 'o3')).toBe(false)
    expect(isModelLevelRejected('stream', 'azure', 'gpt-5')).toBe(false)
  })

  it('rejects temperature, top_p and penalties for grok-3-mini', () => {
    expect(rejected('xai', 'grok-3-mini')).toEqual([...SAMPLERS])
    expect(rejected('xai', 'grok-3-mini-fast')).toEqual([...SAMPLERS])
  })

  it.each(['grok-3', 'grok-4', 'grok-4-0709'])(
    'rejects only penalties for %s',
    (modelId) => {
      expect(rejected('xai', modelId)).toEqual([
        'frequency_penalty',
        'presence_penalty',
      ])
    }
  )

  it('accepts every sampler for older grok models', () => {
    expect(rejected('xai', 'grok-2')).toEqual([])
    expect(rejected('xai', 'grok-beta')).toEqual([])
  })

  it('never rejects for other providers, even with reasoning-like ids', () => {
    for (const provider of ['anthropic', 'openrouter', 'llamacpp', 'custom']) {
      expect(rejected(provider, 'o3-mini')).toEqual([])
      expect(rejected(provider, 'grok-3-mini')).toEqual([])
    }
  })
})
