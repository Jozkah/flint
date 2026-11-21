import { beforeEach, describe, expect, it } from 'vitest'
import {
  listedCapabilities,
  listedEntryCapabilities,
  recordListedCapabilities,
  recordListedDecisionModels,
  recordListedImageModels,
  resetListedCapabilities,
} from '../listedCapabilities'
import { decisionModelsUrl, imageModelsUrl, isRequestyProvider } from '../requesty'
import { isDecisionOnlyModel } from '../decisionModel'
import { isListedDecisionModel, normalizeBackend } from '../decisionBackends'
import { initialModelCapabilities } from '../models'
import { isImageOnlyModel } from '../imageOnlyModel'
import { isChatCapable } from '../providerReadiness'
import { isRouterModelSelectable } from '../mcp-router-model-filter'

const BASE = 'https://router.requesty.ai/v1'

describe('Requesty model list flags', () => {
  beforeEach(() => resetListedCapabilities())

  it('reads tools, vision and image generation from the supports_* flags', () => {
    expect(
      listedEntryCapabilities({
        id: 'a',
        supports_tool_calling: true,
        supports_vision: true,
        supports_image_generation: false,
      })
    ).toEqual(['tools', 'vision'])
    expect(
      listedEntryCapabilities({ id: 'b', supports_tool_calling: false, supports_vision: false })
    ).toEqual([])
  })

  it('says a chat model that can also draw still chats', () => {
    expect(listedEntryCapabilities({ id: 'g', supports_image_generation: true })).toEqual([
      'image_generation',
      'completion',
    ])
  })

  it('says nothing when the entry has no flags and no metadata', () => {
    expect(listedEntryCapabilities({ id: 'plain' })).toBeNull()
    expect(listedEntryCapabilities(null)).toBeNull()
  })

  it('records them per model from a /models payload', () => {
    recordListedCapabilities(BASE, {
      object: 'list',
      data: [{ id: 'openai/gpt-4o', supports_tool_calling: true, supports_vision: true }],
    })
    expect(listedCapabilities(BASE, 'openai/gpt-4o')).toEqual(['tools', 'vision'])
  })
})

describe('picture models listed apart from chat ones', () => {
  beforeEach(() => resetListedCapabilities())

  it('tags them picture-only and returns their ids', () => {
    const ids = recordListedImageModels(BASE, {
      data: [{ id: 'azure/openai/gpt-image-1' }, { id: ' vendor/drawer ' }, { id: '' }, {}],
    })
    expect(ids).toEqual(['azure/openai/gpt-image-1', 'vendor/drawer'])
    expect(listedCapabilities(BASE, 'azure/openai/gpt-image-1')).toEqual(['image_generation'])
  })

  it('keeps chat on a model that is in both lists with image support', () => {
    recordListedCapabilities(BASE, { data: [{ id: 'google/gemini-image', supports_image_generation: true }] })
    recordListedImageModels(BASE, { data: [{ id: 'google/gemini-image' }] })
    expect(listedCapabilities(BASE, 'google/gemini-image')).toContain('completion')
  })

  it('handles a missing or malformed payload', () => {
    expect(recordListedImageModels(BASE, null)).toEqual([])
    expect(recordListedImageModels(BASE, { data: 'nope' })).toEqual([])
    expect(recordListedImageModels(undefined, { data: [{ id: 'x' }] })).toEqual([])
  })

  it('starts a picture-only model without Completion', () => {
    const caps = initialModelCapabilities('requesty', 'azure/openai/gpt-image-1', ['image_generation'])
    expect(caps).toEqual(['image_generation'])
    expect(isImageOnlyModel({ capabilities: caps })).toBe(true)
  })

  it('starts a chat model that can draw with both', () => {
    const caps = initialModelCapabilities('requesty', 'google/gemini-image', [
      'image_generation',
      'completion',
    ])
    expect(caps).toEqual(expect.arrayContaining(['completion', 'image_generation']))
    expect(isImageOnlyModel({ capabilities: caps })).toBe(false)
  })

  it('leaves a model with no listing exactly as before', () => {
    expect(initialModelCapabilities('requesty', 'openai/gpt-4o', null)).toContain('completion')
  })
})

describe('decision models listed apart from chat ones', () => {
  beforeEach(() => resetListedCapabilities())

  it('tags them decision-only and returns their ids', () => {
    const ids = recordListedDecisionModels(BASE, {
      object: 'list',
      data: [{ id: 'typesafe/jev-1.14.0', api: 'decision' }, { id: ' cloudflare/clef ' }, {}],
    })
    expect(ids).toEqual(['typesafe/jev-1.14.0', 'cloudflare/clef'])
    expect(listedCapabilities(BASE, 'typesafe/jev-1.14.0')).toEqual(['decision'])
  })

  it('keeps chat on a model that is also a chat model', () => {
    recordListedCapabilities(BASE, { data: [{ id: 'openai/gpt-6-luna', supports_image_generation: true }] })
    recordListedDecisionModels(BASE, { data: [{ id: 'openai/gpt-6-luna' }] })
    expect(listedCapabilities(BASE, 'openai/gpt-6-luna')).toEqual(expect.arrayContaining(['completion', 'decision']))
  })

  it('handles a missing or malformed payload', () => {
    expect(recordListedDecisionModels(BASE, null)).toEqual([])
    expect(recordListedDecisionModels(BASE, { data: 'nope' })).toEqual([])
    expect(recordListedDecisionModels(undefined, { data: [{ id: 'x' }] })).toEqual([])
  })

  it('starts a decision-only model without Completion and out of chat pickers', () => {
    const caps = initialModelCapabilities('requesty', 'typesafe/jev-1.14.0', ['decision'])
    expect(caps).not.toContain('completion')
    expect(isDecisionOnlyModel({ capabilities: caps })).toBe(true)
    expect(isChatCapable({ id: 'typesafe/jev-1.14.0', capabilities: caps })).toBe(false)
  })

  it('builds the decision list URL from the base', () => {
    expect(decisionModelsUrl('https://router.requesty.ai/v1/')).toBe('https://router.requesty.ai/v1/models/decision')
    expect(decisionModelsUrl('')).toBeNull()
  })

  it('offers them in the decision picker only, past the chat-name heuristic', () => {
    const provider = { provider: 'requesty', api_key: 'rq-key' } as ModelProvider
    const jev = { id: 'typesafe/jev-1.14.0', capabilities: ['decision'] } as Model
    expect(isRouterModelSelectable(provider, jev)).toBe(false)
    expect(isRouterModelSelectable(provider, jev, { decision: true })).toBe(true)
    expect(isRouterModelSelectable({ provider: 'requesty' } as ModelProvider, jev, { decision: true })).toBe(false)
  })

  it('remembers a picked decision model in the backend', () => {
    const providers = [{ provider: 'requesty', models: [{ id: 'typesafe/jev-1.14.0', capabilities: ['decision'] }, { id: 'openai/gpt-4o-mini' }] }]
    expect(isListedDecisionModel(providers, 'requesty', 'typesafe/jev-1.14.0')).toBe(true)
    expect(isListedDecisionModel(providers, 'requesty', 'openai/gpt-4o-mini')).toBe(false)
    expect(
      normalizeBackend({ kind: 'open_model', provider: 'requesty', model: 'typesafe/jev-1.14.0', decision: true })
    ).toEqual({ kind: 'open_model', provider: 'requesty', model: 'typesafe/jev-1.14.0', decision: true })
    expect(normalizeBackend({ kind: 'open_model', provider: 'p', model: 'm', decision: 'yes' })).toEqual({
      kind: 'open_model', provider: 'p', model: 'm',
    })
  })
})

describe('chat pickers skip picture-only models', () => {
  const picture = { id: 'azure/openai/gpt-image-1', capabilities: ['image_generation'] }
  const chat = { id: 'openai/gpt-4o-mini', capabilities: ['completion'] }

  it('treats them as not chat-capable', () => {
    expect(isChatCapable(picture)).toBe(false)
    expect(isChatCapable(chat)).toBe(true)
  })

  it('does not offer them for decision routing', () => {
    const provider = { provider: 'requesty', api_key: 'rq-key' } as ModelProvider
    expect(isRouterModelSelectable(provider, { ...picture, id: 'google/gemini-flash-image' } as Model)).toBe(false)
    expect(isRouterModelSelectable(provider, chat as Model)).toBe(true)
  })
})

describe('Requesty endpoints', () => {
  it('knows the provider by id or by address', () => {
    expect(isRequestyProvider({ provider: 'requesty' })).toBe(true)
    expect(isRequestyProvider({ provider: 'x', base_url: 'https://router.eu.requesty.ai/v1' })).toBe(true)
    expect(isRequestyProvider({ provider: 'x', base_url: 'https://requesty.ai/v1' })).toBe(true)
    expect(isRequestyProvider({ provider: 'x', base_url: 'https://notrequesty.ai/v1' })).toBe(false)
    expect(isRequestyProvider({ provider: 'x', base_url: 'not a url' })).toBe(false)
    expect(isRequestyProvider({ provider: 'x' })).toBe(false)
  })

  it('builds the picture list URL from the base', () => {
    expect(imageModelsUrl('https://router.requesty.ai/v1/')).toBe('https://router.requesty.ai/v1/models/image')
    expect(imageModelsUrl('')).toBeNull()
    expect(imageModelsUrl(undefined)).toBeNull()
  })
})
