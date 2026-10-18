import { describe, it, expect } from 'vitest'
import {
  paramsSettings,
  resolveSamplerValue,
  samplerKeysForProvider,
  SAMPLER_DEFAULT_KEYS,
  MLX_SAMPLER_KEYS,
  paramCategories,
  paramGroups,
} from '../predefinedParams'
import { modelSettings } from '../predefined'

describe('predefinedParams', () => {
  it('exports paramsSettings object', () => {
    expect(paramsSettings).toBeDefined()
    expect(typeof paramsSettings).toBe('object')
  })

  it('has expected parameter keys', () => {
    const keys = Object.keys(paramsSettings)
    expect(keys).toContain('stream')
    expect(keys).toContain('temperature')
    expect(keys).toContain('max_output_tokens')
    expect(keys).toContain('max_context_tokens')
    expect(keys).toContain('auto_compact')
    expect(keys).toContain('frequency_penalty')
    expect(keys).toContain('presence_penalty')
    expect(keys).toContain('top_p')
    expect(keys).toContain('top_k')
  })

  it('each param has key, value, title, description', () => {
    for (const [name, param] of Object.entries(paramsSettings)) {
      expect(param.key).toBe(name)
      expect(param.value).toBeDefined()
      expect(typeof param.title).toBe('string')
      expect(typeof param.description).toBe('string')
    }
  })

  it('stream defaults to true', () => {
    expect(paramsSettings.stream.value).toBe(true)
  })

  it('temperature defaults to llama.cpp default (0.8)', () => {
    expect(paramsSettings.temperature.value).toBe(0.8)
  })

  it('max_output_tokens defaults to 2048', () => {
    expect(paramsSettings.max_output_tokens.value).toBe(2048)
  })

  it('auto_compact defaults to false', () => {
    expect(paramsSettings.auto_compact.value).toBe(false)
  })

  it('top_p has controllerType slider', () => {
    expect((paramsSettings.top_p as any).controllerType).toBe('slider')
  })

  it('MLX exposes only the samplers its server forwards', () => {
    expect([...MLX_SAMPLER_KEYS]).toEqual([
      'temperature',
      'top_p',
      'repeat_penalty',
    ])
    expect(samplerKeysForProvider('mlx')).toBe(MLX_SAMPLER_KEYS)
    expect(samplerKeysForProvider('llamacpp')).toBe(SAMPLER_DEFAULT_KEYS)
  })

  it('resolveSamplerValue treats empty string as unset', () => {
    expect(resolveSamplerValue('', 0.8)).toBe(0.8)
    expect(resolveSamplerValue(undefined, 0.8)).toBe(0.8)
    expect(resolveSamplerValue(null, 0.8)).toBe(0.8)
    expect(resolveSamplerValue(0, 0.8)).toBe(0)
    expect(resolveSamplerValue(0.5, 0.8)).toBe(0.5)
  })
})

describe('engine controls are reachable from the UI', () => {
  it('lists every sampler parameter in the add-parameter menu', () => {
    const reachable = new Set<string>([
      ...paramCategories.flatMap((c) => c.paramKeys),
      ...paramGroups.flatMap((g) => g.members),
    ])
    // Plumbing the composer sets itself rather than offering as a sampler.
    const internal = new Set(['stream', 'max_context_tokens', 'auto_compact'])
    const missing = Object.keys(paramsSettings).filter(
      (k) => !reachable.has(k) && !internal.has(k)
    )
    expect(missing).toEqual([])
  })

  it('offers the full llama.cpp sampler set plus a fixed seed', () => {
    for (const key of [
      'temperature', 'top_p', 'top_k', 'min_p', 'typical_p', 'top_n_sigma',
      'repeat_penalty', 'repeat_last_n', 'presence_penalty', 'frequency_penalty',
      'mirostat', 'mirostat_tau', 'mirostat_eta', 'dry_multiplier', 'dry_base',
      'dry_allowed_length', 'dry_penalty_last_n', 'xtc_probability',
      'xtc_threshold', 'dynatemp_range', 'dynatemp_exp', 'samplers', 'seed',
    ]) {
      expect(paramsSettings[key], key).toBeDefined()
    }
    expect(paramsSettings.seed.value).toBe(-1)
  })

  it('shows Seed as a per-model sampler default', () => {
    expect(SAMPLER_DEFAULT_KEYS).toContain('seed')
    expect(modelSettings.seed.key).toBe('seed')
    expect(samplerKeysForProvider('mlx')).not.toContain('seed')
  })

  it('renders the custom chat template in the model sidebar', () => {
    // ModelSetting draws every model setting that is not a sampler param, so
    // the template box is there as long as it is a stored, non-param setting.
    expect(modelSettings.chatTemplate.key).toBe('chat_template')
    expect(modelSettings.chatTemplate.controller_type).toBe('textarea')
    expect('chat_template' in paramsSettings).toBe(false)
  })
})
