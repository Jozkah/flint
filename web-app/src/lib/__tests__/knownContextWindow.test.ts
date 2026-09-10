import { describe, it, expect, afterEach } from 'vitest'
import {
  knownContextWindow,
  stoppedAtContextLimit,
} from '@/lib/knownContextWindow'
import {
  forgetAllServerLimits,
  rememberServerLimit,
} from '@/lib/contextLimitRecovery'

const customProvider = { provider: 'my-vllm', base_url: 'http://127.0.0.1:8000/v1' }

describe('knownContextWindow', () => {
  afterEach(() => forgetAllServerLimits())

  it('reads the window the user configured', () => {
    const model = {
      id: 'custom-model',
      settings: { ctx_len: { controller_props: { value: 16384 } } },
    }
    expect(knownContextWindow(model, customProvider)).toBe(16384)
  })

  // janhq/jan#8760: a custom endpoint model has no ctx_len, and the chat route
  // used to assume 32,768 for it.
  it('knows nothing about a custom model that reports nothing', () => {
    expect(knownContextWindow({ id: 'custom-model' }, customProvider)).toBeNull()
  })

  it('uses what the provider describes', () => {
    expect(
      knownContextWindow({ id: 'custom-model', max_model_len: 131072 }, customProvider)
    ).toBe(131072)
  })

  it('uses what the server said when it refused a request', () => {
    rememberServerLimit(
      { provider: 'my-vllm', baseUrl: 'http://127.0.0.1:8000/v1', model: 'custom-model' },
      { contextTokens: 8192, requestTokens: 9000, via: 'structured-field' }
    )
    expect(knownContextWindow({ id: 'custom-model' }, customProvider)).toBe(8192)
  })

  it('does not borrow a limit learned from another endpoint', () => {
    rememberServerLimit(
      { provider: 'my-vllm', baseUrl: 'http://other:8000/v1', model: 'custom-model' },
      { contextTokens: 8192, requestTokens: 9000, via: 'structured-field' }
    )
    expect(knownContextWindow({ id: 'custom-model' }, customProvider)).toBeNull()
  })

  it('has nothing to say without a model', () => {
    expect(knownContextWindow(null, customProvider)).toBeNull()
    expect(knownContextWindow({ id: '' }, customProvider)).toBeNull()
  })
})

describe('stoppedAtContextLimit', () => {
  it('is never a verdict against an unknown window', () => {
    // The old 32,768 guess called this an overflow on a 128k model.
    expect(stoppedAtContextLimit(30_000, null)).toBe(false)
  })

  it('recognises a stop at the edge of a known window', () => {
    expect(stoppedAtContextLimit(15_000, 16_384)).toBe(true)
    expect(stoppedAtContextLimit(16_384, 16_384)).toBe(true)
  })

  it('treats a stop well inside the window as an output cap', () => {
    expect(stoppedAtContextLimit(1_000, 16_384)).toBe(false)
    expect(stoppedAtContextLimit(30_000, 131_072)).toBe(false)
  })
})
