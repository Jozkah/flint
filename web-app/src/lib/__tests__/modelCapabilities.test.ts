/** AH-195: where the context window comes from, and what it is allowed to say. */
import { describe, expect, it } from 'vitest'
import {
  bundledContextFor,
  contextWindowNote,
  formatContextUsage,
  readCapabilityField,
  resolveModelCapabilities,
  usableContextValue,
  CONTEXT_FIELDS,
  TRAINING_FIELDS,
} from '../modelCapabilities'

describe('reading a window off whatever the server sent', () => {
  it('recognizes the names an OpenAI-compatible server actually uses', () => {
    for (const field of [
      'context_length',
      'max_context_length',
      'max_model_len',
      'n_ctx',
    ]) {
      expect(readCapabilityField({ [field]: 32768 }, CONTEXT_FIELDS)).toBe(32768)
    }
  })

  it("reads Jan's own nested settings shape", () => {
    const model = {
      settings: { ctx_len: { controller_props: { value: '8192' } } },
    }
    expect(readCapabilityField(model, CONTEXT_FIELDS)).toBe(8192)
  })

  it('looks one level down, where /models entries put it', () => {
    expect(
      readCapabilityField({ meta: { context_length: 4096 } }, CONTEXT_FIELDS)
    ).toBe(4096)
  })

  it('never reads the reply cap as the window', () => {
    expect(readCapabilityField({ max_tokens: 4096 }, CONTEXT_FIELDS)).toBe(null)
  })

  it('refuses a nonsense value rather than passing it on', () => {
    for (const value of [0, -1, 'many', null, undefined, NaN]) {
      expect(readCapabilityField({ n_ctx: value }, CONTEXT_FIELDS)).toBe(null)
    }
  })

  it('keeps the training size apart from the window in force', () => {
    const props = { n_ctx: 8192, n_ctx_train: 32768 }
    expect(readCapabilityField(props, CONTEXT_FIELDS)).toBe(8192)
    expect(readCapabilityField(props, TRAINING_FIELDS)).toBe(32768)
  })
})

describe('discovery order', () => {
  const providerMetadata = { context_length: 32768 }
  const localRuntime = { n_ctx: 8192, n_ctx_train: 32768 }

  it("puts the user's decision above anything discovered", () => {
    const caps = resolveModelCapabilities({
      override: { ctx_len: 4096 },
      providerMetadata,
      localRuntime,
    })
    expect(caps).toMatchObject({ contextTokens: 4096, source: 'user-override' })
  })

  it('prefers what the provider said to what the app assumes', () => {
    const caps = resolveModelCapabilities({
      providerMetadata,
      providerDefault: { context_length: 2048 },
    })
    expect(caps).toMatchObject({
      contextTokens: 32768,
      source: 'provider-metadata',
    })
  })

  it("reports llama.cpp's effective window, not the model's training size", () => {
    const caps = resolveModelCapabilities({ localRuntime })
    expect(caps.contextTokens).toBe(8192)
    expect(caps.trainingMaxTokens).toBe(32768)
    expect(caps.source).toBe('local-runtime')
  })

  it('falls back to bundled metadata only when nothing else knows', () => {
    const caps = resolveModelCapabilities({ modelId: 'qwen3-8b-instruct' })
    expect(caps).toMatchObject({ contextTokens: 32768, source: 'bundled' })
    expect(
      resolveModelCapabilities({
        modelId: 'qwen3-8b-instruct',
        providerMetadata: { context_length: 4096 },
      }).source
    ).toBe('provider-metadata')
  })

  it('leaves an unknown window unknown rather than guessing', () => {
    const caps = resolveModelCapabilities({ modelId: 'something-nobody-ships' })
    expect(caps.contextTokens).toBe(null)
    expect(caps.source).toBe('unknown')
    expect(bundledContextFor('something-nobody-ships')).toBe(null)
  })
})

describe('what the user is shown', () => {
  it('reads as a window, with the digits grouped', () => {
    // The separator is the reader's, not en-US's: `toLocaleString` groups
    // according to the host locale, so asserting on commas failed on any
    // machine that does not use them (pt-PT renders `32 768`). What is under
    // test is that both numbers are grouped and laid out as a window, so the
    // expectation is built the same way the string under test is.
    const n = (value: number) => value.toLocaleString()
    expect(formatContextUsage(3367, 32768)).toBe(
      `${n(3367)} / ${n(32768)} tokens`
    )
  })

  it('shows nothing rather than a made-up total', () => {
    expect(formatContextUsage(3367, null)).toBe(null)
    expect(formatContextUsage(3367, 0)).toBe(null)
  })

  it('says which of the two numbers is biting, and only when they differ', () => {
    expect(
      contextWindowNote({
        contextTokens: 8192,
        trainingMaxTokens: 32768,
        source: 'local-runtime',
      })
    ).toContain((8192).toLocaleString())
    expect(
      contextWindowNote({
        contextTokens: 32768,
        trainingMaxTokens: 32768,
        source: 'local-runtime',
      })
    ).toBe(null)
  })
})

/**
 * The one gate every context number goes through. Zero is the interesting
 * case: a model whose window is genuinely zero cannot hold a prompt, so a zero
 * on the wire is bad metadata rather than a small capacity -- and reading it as
 * a capacity is what produced `0 / 0` in the indicator and `max_tokens: 0` in
 * the request.
 */
describe('what counts as a usable context value', () => {
  it.each([
    ['integer zero', 0],
    ['the string "0"', '0'],
    ['a negative number', -1],
    ['a negative string', '-8192'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a malformed string', 'lots'],
    ['whitespace', '   '],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', {}],
    ['an array', [8192]],
  ])('rejects %s', (_label, value) => {
    expect(usableContextValue(value)).toBeNull()
  })

  it.each([
    ['a plain number', 8192, 8192],
    ['a numeric string', '32768', 32768],
    ['a float', 4096.7, 4096],
    ['one token', 1, 1],
    ['a very large window', 1_048_576, 1_048_576],
  ])('accepts %s', (_label, value, expected) => {
    expect(usableContextValue(value)).toBe(expected)
  })

  it('is what discovery already applies to every source', () => {
    // A provider reporting a zero window must leave the capacity unknown
    // rather than resolving to a real window of nothing.
    const caps = resolveModelCapabilities({
      modelId: 'some-unlisted-model',
      providerMetadata: { context_length: 0 },
    })
    expect(caps.contextTokens).toBeNull()
    expect(caps.source).toBe('unknown')
  })

  it('never renders a window of zero as a usage string', () => {
    expect(formatContextUsage(10, 0)).toBeNull()
    expect(formatContextUsage(10, -1)).toBeNull()
    expect(formatContextUsage(10, null)).toBeNull()
    // Grouping separators are the host locale's business; what matters here
    // is that a real window renders and a zero one does not.
    expect(formatContextUsage(3367, 32768)).toContain('tokens')
  })
})
