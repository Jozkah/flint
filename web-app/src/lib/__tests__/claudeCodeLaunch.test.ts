import { describe, expect, it, vi } from 'vitest'
import {
  availableHelperModels,
  claudeCodeApiUrl,
  raiseLocalContexts,
  serverModelsToPersist,
  waitForModelsActive,
} from '../claudeCodeLaunch'

const providers = [
  { provider: 'llamacpp', active: true, models: [{ id: 'qwen' }, { id: 'gemma' }] },
  { provider: 'openai', active: true, api_key: 'sk', models: [{ id: 'gpt' }] },
  { provider: 'groq', active: true, api_key: '', models: [{ id: 'llama-g' }] },
  { provider: 'mistral', active: false, api_key: 'k', models: [{ id: 'mistral-l' }] },
]
const isLocal = (p: string) => p === 'llamacpp'

describe('availableHelperModels', () => {
  it('keeps models that exist and can run', () => {
    const out = availableHelperModels(
      { fable: null, big: 'qwen', medium: 'gpt', small: null },
      providers,
      isLocal
    )
    expect(out).toEqual({ fable: null, big: 'qwen', medium: 'gpt', small: null })
  })

  it('drops a deleted model, a keyless remote one and an inactive provider', () => {
    const out = availableHelperModels(
      { fable: 'gone', big: 'llama-g', medium: 'mistral-l', small: 'gemma' },
      providers,
      isLocal
    )
    expect(out).toEqual({ fable: null, big: null, medium: null, small: 'gemma' })
  })
})

describe('claudeCodeApiUrl', () => {
  it('uses the port the server bound', () => {
    expect(claudeCodeApiUrl('127.0.0.1', 1338)).toBe('http://127.0.0.1:1338')
  })

  it('connects to loopback when bound to every interface', () => {
    expect(claudeCodeApiUrl('0.0.0.0', 1338)).toBe('http://127.0.0.1:1338')
    expect(claudeCodeApiUrl('::', 1338)).toBe('http://[::1]:1338')
    expect(claudeCodeApiUrl('fe80::1', 1338)).toBe('http://[fe80::1]:1338')
  })
})

describe('waitForModelsActive', () => {
  it('returns at once when the models are already active', async () => {
    const get = vi.fn().mockResolvedValue(['a', 'b'])
    expect(await waitForModelsActive(get, ['a'])).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('polls until the model shows up', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['a'])
    expect(await waitForModelsActive(get, ['a'], { intervalMs: 1 })).toBe(true)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('gives up after the timeout and survives a failing poll', async () => {
    const get = vi.fn().mockRejectedValue(new Error('x'))
    expect(
      await waitForModelsActive(get, ['a'], { timeoutMs: 5, intervalMs: 1 })
    ).toBe(false)
  })
})

describe('serverModelsToPersist', () => {
  it('keeps only models with a known provider', () => {
    expect(serverModelsToPersist(['qwen', 'ghost'], providers)).toEqual([
      { model: 'qwen', provider: 'llamacpp' },
    ])
  })
})

describe('raiseLocalContexts', () => {
  const makeDeps = (loaded: string[]) => {
    const provider = { models: [{ id: 'a', settings: {} }, { id: 'b', settings: {} }] }
    return {
      getProvider: vi.fn((): typeof provider | undefined => provider),
      updateModelSettings: vi.fn(async () => undefined),
      updateProvider: vi.fn(),
      getActiveModels: vi.fn(async () => loaded),
      stopModel: vi.fn(async () => undefined),
      onRaised: vi.fn(),
    }
  }

  it('writes, reloads a loaded model and reports', async () => {
    const deps = makeDeps(['a'])
    await raiseLocalContexts({ a: { raiseTo: 32768 }, b: { raiseTo: null } }, deps)
    expect(deps.updateModelSettings).toHaveBeenCalledTimes(1)
    expect(deps.updateModelSettings).toHaveBeenCalledWith('a', { ctx_len: 32768 })
    const models = deps.updateProvider.mock.calls[0][0]
    expect(models[0].settings.ctx_len.controller_props.value).toBe(32768)
    expect(deps.stopModel).toHaveBeenCalledWith('a')
    expect(deps.onRaised).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 32768)
  })

  it('does not stop an unloaded model and survives a failure', async () => {
    const deps = makeDeps([])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.updateModelSettings.mockRejectedValueOnce(new Error('x'))
    await raiseLocalContexts({ a: { raiseTo: 1 }, b: { raiseTo: 2 } }, deps)
    expect(deps.stopModel).not.toHaveBeenCalled()
    expect(deps.onRaised).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a provider', async () => {
    const deps = makeDeps([])
    deps.getProvider.mockReturnValue(undefined)
    await raiseLocalContexts({ a: { raiseTo: 1 } }, deps)
    expect(deps.updateModelSettings).not.toHaveBeenCalled()
  })
})
