import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: vi.fn(() => ({})),
}))

import { useModelProvider } from '../useModelProvider'

// Characterization of the persisted-state migration: one run per stored
// version over a fixture that touches every branch. The snapshots pin the
// output so moving the code out of the store file cannot change behaviour.

const setting = (key: string, value: unknown) => ({
  key,
  title: key,
  description: key,
  controller_type: 'input',
  controller_props: { value },
})

function fixture() {
  return {
    selectedProvider: 'llamacpp',
    selectedModel: null,
    deletedModels: [
      'legacy-model',
      { provider: 'openai', id: 'gpt-x' },
      { provider: 'openai' },
      42,
      null,
    ],
    providers: [
      {
        provider: 'llamacpp',
        active: true,
        base_url: '',
        api_key: '',
        explore_models_url: '',
        settings: [
          setting('cont_batching', true),
          setting('flash_attn', true),
          setting('ctx_len', 8192),
          setting('auto_unload', false),
        ],
        models: [
          {
            id: 'bare',
            capabilities: ['completion', 'tools'],
            settings: {},
          },
          {
            id: 'bare',
            settings: undefined,
          },
          {
            id: 'with-template',
            settings: {
              chatTemplate: 'tpl',
              ctx_len: { controller_props: { value: 8192 } },
              auto_increase_ctx_len: true,
            },
          },
          {
            id: 'odd-ctx',
            settings: {
              ctx_len: { controller_props: { value: 'not-a-number' } },
              batch_size: { controller_props: { value: 1 } },
            },
          },
          {
            id: 'keep-ctx',
            settings: { ctx_len: { controller_props: { value: 4096 } } },
          },
        ],
      },
      {
        provider: 'anthropic',
        active: true,
        base_url: 'https://api.anthropic.com',
        api_key: '',
        explore_models_url: '',
        settings: [setting('base-url', 'https://api.anthropic.com')],
        models: [],
      },
      {
        provider: 'cohere',
        active: true,
        base_url: 'https://api.cohere.ai/compatibility',
        api_key: '',
        explore_models_url: '',
        settings: [setting('base-url', 'https://api.cohere.ai/compatibility')],
        models: [],
      },
      {
        provider: 'mistral',
        active: true,
        base_url: 'https://api.mistral.ai',
        api_key: '',
        explore_models_url: '',
        settings: [setting('base-url', 'https://api.mistral.ai')],
        models: [],
      },
      {
        provider: 'azure',
        active: true,
        base_url: 'https://your-resource-name.openai.azure.com/openai/v1',
        api_key: '',
        explore_models_url: '',
        settings: [
          setting('base-url', 'https://your-resource-name.openai.azure.com/openai/v1'),
        ],
        models: [],
      },
      {
        provider: 'openai',
        active: true,
        base_url: 'https://api.openai.com/v1',
        api_key: '',
        explore_models_url: '',
        settings: [setting('base-url', 'https://api.openai.com/v1')],
        models: [
          { id: 'gpt-x', capabilities: ['tools'] },
          { id: 'gpt-y' },
        ],
      },
    ],
  }
}

describe('useModelProvider migrate', () => {
  const migrate = useModelProvider.persist.getOptions().migrate!

  it('declares the current persisted version', () => {
    expect(useModelProvider.persist.getOptions().version).toBe(27)
  })

  for (let version = 0; version <= 26; version++) {
    it(`migrates a version ${version} state`, () => {
      expect(migrate(fixture(), version)).toMatchSnapshot()
    })
  }

  it('moves a saved Max Context Tokens onto the model contextWindow at v27', () => {
    const withLimits = () => ({
      providers: [
        {
          provider: 'openai',
          active: true,
          settings: [],
          models: [
            { id: 'saved', settings: { max_context_tokens: setting('max_context_tokens', 32768) } },
            { id: 'zero', settings: { max_context_tokens: setting('max_context_tokens', 0) } },
            { id: 'kept', contextWindow: 1000, settings: { max_context_tokens: setting('max_context_tokens', 32768) } },
            { id: 'out', settings: { max_output_tokens: setting('max_output_tokens', '4096') } },
            { id: 'bare' },
          ],
        },
      ],
    })
    type Out = { providers: Array<{ models: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }> }> }
    const models = (migrate(withLimits(), 26) as unknown as Out).providers[0].models
    const by = (id: string) => models.find((m) => m.id === id)!
    expect(by('saved').contextWindow).toBe(32768)
    expect(by('zero').contextWindow).toBeUndefined()
    expect(by('kept').contextWindow).toBe(1000)
    expect(by('out').maxOutputTokens).toBe(4096)
    expect(by('bare').contextWindow).toBeUndefined()
    // Already at v27: untouched.
    const current = (migrate(withLimits(), 27) as unknown as Out).providers[0].models
    expect(current.find((m) => m.id === 'saved')!.contextWindow).toBeUndefined()
  })

  it('keeps a context size of 8192 the user chose after v12, clears the seeded one', () => {
    const ctxOf = (state: unknown, id: string) =>
      (
        state as {
          providers: Array<{
            models: Array<{
              id: string
              settings: { ctx_len: { controller_props: { value: unknown } } }
            }>
          }>
        }
      ).providers[0].models.find((m) => m.id === id)!.settings.ctx_len
        .controller_props.value
    const chosen = migrate(fixture(), 14)
    expect(ctxOf(chosen, 'with-template')).toBe(8192)
    const seeded = migrate(fixture(), 20)
    expect(ctxOf(seeded, 'with-template')).toBe('')
  })

  it('passes through a missing state', () => {
    expect(migrate(undefined, 0)).toBeUndefined()
  })
})
