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
    expect(useModelProvider.persist.getOptions().version).toBe(25)
  })

  for (let version = 0; version <= 25; version++) {
    it(`migrates a version ${version} state`, () => {
      expect(migrate(fixture(), version)).toMatchSnapshot()
    })
  }

  it('passes through a missing state', () => {
    expect(migrate(undefined, 0)).toBeUndefined()
  })
})
