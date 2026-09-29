import { describe, expect, it } from 'vitest'
import {
  buildJevRouteOptions,
  jevModeSuggestion,
  parseJevRouteChoice,
} from '@/lib/jevRouting'

const assistants = [
  { id: 'jan', name: 'Flint', description: 'Generalist' },
  { id: 'quartz', name: 'Quartz', description: 'Research' },
  { id: 'coal', name: 'Coal', description: 'Engineering' },
  { id: 'blaze', name: 'Blaze', description: 'Creative' },
  { id: 'redstone', name: 'Redstone', description: 'Automation' },
  { id: 'custom', name: 'Custom', description: 'Pinned by the user' },
]

describe('Jev prompt routing', () => {
  it('offers only the five built-in Flint-family assistants in Chat', () => {
    const options = buildJevRouteOptions(assistants as any, false)
    expect(options).toHaveLength(5)
    expect(options.map((option) => option.name)).toEqual([
      'jev-route:jan',
      'jev-route:quartz',
      'jev-route:coal',
      'jev-route:blaze',
      'jev-route:redstone',
    ])
  })

  it('offers the bounded assistant x mode cross-product in Cowork', () => {
    const options = buildJevRouteOptions(assistants as any, true)
    expect(options).toHaveLength(15)
    expect(options.some((option) => option.name === 'jev-route:coal:ask')).toBe(true)
    expect(options.some((option) => option.name === 'jev-route:redstone:auto')).toBe(true)
  })

  it('accepts only validated built-in assistant and mode choices', () => {
    expect(parseJevRouteChoice('jev-route:quartz:review')).toEqual({
      assistantId: 'quartz',
      mode: 'review',
    })
    expect(parseJevRouteChoice('jev-route:blaze')).toEqual({
      assistantId: 'blaze',
      mode: null,
    })
    expect(parseJevRouteChoice('jev-route:custom:auto')).toBeNull()
    expect(parseJevRouteChoice('jev-route:coal:dangerous')).toBeNull()
  })

  it('makes the mode recommendation explicitly non-authoritative', () => {
    const hint = jevModeSuggestion('auto')
    expect(hint).toContain('behavioural guidance only')
    expect(hint).toContain('does not change tool permissions')
  })
})
