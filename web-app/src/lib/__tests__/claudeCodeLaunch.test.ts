import { describe, expect, it } from 'vitest'
import { availableHelperModels, claudeCodeApiUrl } from '../claudeCodeLaunch'

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
})
