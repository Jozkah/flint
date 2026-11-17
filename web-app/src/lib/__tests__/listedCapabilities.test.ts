import { describe, it, expect, beforeEach } from 'vitest'
import {
  listedCapabilities,
  recordListedCapabilities,
  resetListedCapabilities,
} from '../listedCapabilities'
import { isImageOnlyModel } from '../imageOnlyModel'

const BASE = 'https://openrouter.ai/api/v1'

describe('listedCapabilities', () => {
  beforeEach(() => resetListedCapabilities())

  it('reads tools and vision from OpenRouter metadata', () => {
    recordListedCapabilities(BASE, {
      data: [
        {
          id: 'a/vision-tools',
          supported_parameters: ['temperature', 'tools', 'tool_choice'],
          architecture: { input_modalities: ['text', 'image'] },
        },
        {
          id: 'b/plain',
          supported_parameters: ['temperature'],
          architecture: { input_modalities: ['text'] },
        },
      ],
    })
    expect(listedCapabilities(BASE, 'a/vision-tools')).toEqual(['tools', 'vision'])
    expect(listedCapabilities(BASE + '/', 'b/plain')).toEqual([])
  })

  it('says nothing for entries without metadata', () => {
    recordListedCapabilities(BASE, { data: [{ id: 'x' }, 'y', null] })
    expect(listedCapabilities(BASE, 'x')).toBeNull()
    expect(listedCapabilities(BASE, 'missing')).toBeNull()
  })

  it('marks a model whose listed task is a picture task as picture-only', () => {
    const url = 'http://localhost:8000/v1'
    recordListedCapabilities(url, {
      data: [
        { id: 'klein', task: 'text-to-image' },
        { id: 'qwen-image-2.1', task: 'image-generation' },
        { id: 'llama', task: 'text-generation' },
      ],
    })
    expect(listedCapabilities(url, 'klein')).toEqual(['image_generation'])
    expect(listedCapabilities(url, 'qwen-image-2.1')).toEqual(['image_generation'])
    expect(isImageOnlyModel({ capabilities: listedCapabilities(url, 'klein') ?? [] })).toBe(true)
    expect(listedCapabilities(url, 'llama')).toBeNull()
  })
})
