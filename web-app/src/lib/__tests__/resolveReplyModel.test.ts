import { describe, expect, it } from 'vitest'
import { estimateParamsB, resolveReplyModel } from '@/lib/resolveReplyModel'

const llama = (...ids: string[]) => ({
  provider: 'llamacpp',
  models: ids.map((id) => ({ id })),
})

describe('estimateParamsB', () => {
  it('reads billions and millions from a model name', () => {
    expect(estimateParamsB({ id: 'Qwen3-8B-Q4_K_M' })).toBe(8)
    expect(estimateParamsB({ id: 'gemma-3-27b-it' })).toBe(27)
    expect(estimateParamsB({ id: 'smollm-360M' })).toBeCloseTo(0.36)
    expect(estimateParamsB({ id: 'llama-3.2-1.5b' })).toBe(1.5)
  })

  it('returns null when the name carries no size', () => {
    expect(estimateParamsB({ id: 'mistral-nemo' })).toBeNull()
    expect(estimateParamsB({ id: 'model-q4_0' })).toBeNull()
  })
})

describe('resolveReplyModel', () => {
  it('prefers the user default, then the last used model', () => {
    const providers = [llama('a-8B', 'b-1B')]
    expect(
      resolveReplyModel({
        providers,
        preferred: { provider: 'llamacpp', model: 'a-8B' },
        lastUsed: { provider: 'llamacpp', model: 'b-1B' },
      })
    ).toEqual({ provider: 'llamacpp', model: 'a-8B' })
    expect(
      resolveReplyModel({
        providers,
        preferred: { provider: 'llamacpp', model: 'gone' },
        lastUsed: { provider: 'llamacpp', model: 'b-1B' },
      })
    ).toEqual({ provider: 'llamacpp', model: 'b-1B' })
  })

  it('uses the only local model', () => {
    expect(resolveReplyModel({ providers: [llama('solo')] })).toEqual({
      provider: 'llamacpp',
      model: 'solo',
    })
  })

  it('picks the lightest named local model otherwise', () => {
    expect(
      resolveReplyModel({ providers: [llama('big-70B', 'mid-8B', 'small-3B')] })
    ).toEqual({ provider: 'llamacpp', model: 'small-3B' })
  })

  it('ranks a model with no stated size after one that has it', () => {
    expect(
      resolveReplyModel({ providers: [llama('mystery', 'known-14B')] })
    ).toEqual({ provider: 'llamacpp', model: 'known-14B' })
  })

  it('never picks an embedding model', () => {
    expect(
      resolveReplyModel({
        providers: [
          {
            provider: 'llamacpp',
            models: [{ id: 'embed-small', embedding: true }, { id: 'chat-8B' }],
          },
        ],
      })
    ).toEqual({ provider: 'llamacpp', model: 'chat-8B' })
    expect(
      resolveReplyModel({
        providers: [
          { provider: 'llamacpp', models: [{ id: 'e', embedding: true }] },
        ],
      })
    ).toBeNull()
  })

  it('prefers a connected remote provider over local models', () => {
    expect(
      resolveReplyModel({
        providers: [
          llama('local-8B'),
          {
            provider: 'openai',
            api_key: 'sk-test',
            models: [{ id: 'gpt-x' }],
          },
        ],
      })
    ).toEqual({ provider: 'openai', model: 'gpt-x' })
  })

  it('ignores a remote provider with no key', () => {
    expect(
      resolveReplyModel({
        providers: [
          { provider: 'openai', models: [{ id: 'gpt-x' }] },
          llama('local-8B'),
        ],
      })
    ).toEqual({ provider: 'llamacpp', model: 'local-8B' })
  })

  it('returns null when nothing can answer', () => {
    expect(resolveReplyModel({ providers: [llama()] })).toBeNull()
  })
})
