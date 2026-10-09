import { describe, it, expect, beforeEach } from 'vitest'
import {
  listedCapabilities,
  recordListedCapabilities,
  resetListedCapabilities,
} from '../listedCapabilities'

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
})
