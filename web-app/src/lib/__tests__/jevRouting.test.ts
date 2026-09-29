import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJevSettings } from '@/hooks/useJevSettings'
import { jevSuggestSkill } from '@/lib/jev'
import {
  buildJevRouteOptions,
  chooseJevPromptRoute,
  jevModeSuggestion,
  parseJevRouteChoice,
} from '@/lib/jevRouting'

vi.mock('@/lib/jev', async (original) => ({
  ...(await original<typeof import('@/lib/jev')>()),
  jevSuggestSkill: vi.fn(),
}))

const suggest = vi.mocked(jevSuggestSkill)

const assistants = [
  { id: 'jan', name: 'Flint', description: 'Generalist' },
  { id: 'quartz', name: 'Quartz', description: 'Research' },
  { id: 'coal', name: 'Coal', description: 'Engineering' },
  { id: 'blaze', name: 'Blaze', description: 'Creative' },
  { id: 'redstone', name: 'Redstone', description: 'Automation' },
  { id: 'custom', name: 'Custom', description: 'Pinned by the user' },
]

describe('Jev prompt routing', () => {
  beforeEach(() => {
    suggest.mockReset()
    useJevSettings.setState({ skillMode: 'on' })
  })

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

  it('selects assistant and advisory mode together', async () => {
    suggest.mockResolvedValue({
      skill: 'jev-route:coal:review', probability: 0.9, fallback: null, model: 'jev',
    })
    expect(await chooseJevPromptRoute({
      message: 'Fix this bug', assistants, includeCoworkMode: true,
    })).toMatchObject({
      assistantId: 'coal', mode: 'review',
    })
    expect(suggest).toHaveBeenCalledOnce()
    expect(suggest.mock.calls[0][1]).toHaveLength(15)
  })

  it.each(['abstained', 'no_key'] as const)(
    'falls back to Flint after %s', async (fallback) => {
      suggest.mockResolvedValue({ skill: null, probability: null, fallback, model: null })
      expect(await chooseJevPromptRoute({ message: 'New task', assistants })).toMatchObject({
        assistantId: 'jan', mode: null, fallback,
      })
    }
  )

  it('falls back to Flint on a transport error', async () => {
    suggest.mockRejectedValue(new Error('unavailable'))
    expect(await chooseJevPromptRoute({ message: 'New task', assistants })).toMatchObject({
      assistantId: 'jan', mode: null,
    })
  })

  it('keeps custom assistants pinned without calling Jev', async () => {
    expect(await chooseJevPromptRoute({
      message: 'Fix this bug', assistants, currentAssistantId: 'custom',
    })).toBeNull()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('does not switch assistants in shadow mode', async () => {
    useJevSettings.setState({ skillMode: 'shadow' })
    suggest.mockResolvedValue({ skill: null, probability: 0.9, fallback: 'shadow', model: 'jev' })
    expect(await chooseJevPromptRoute({ message: 'Fix this bug', assistants })).toMatchObject({
      assistantId: null, mode: null,
    })
  })
})
