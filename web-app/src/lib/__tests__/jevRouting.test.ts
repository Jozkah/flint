import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
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
      message: 'Fix this bug in the parser please', assistants, includeCoworkMode: true,
    })).toMatchObject({
      assistantId: 'coal', mode: 'review',
    })
    expect(suggest).toHaveBeenCalledOnce()
    expect(suggest.mock.calls[0][1]).toHaveLength(15)
  })

  it.each(['abstained', 'no_key'] as const)(
    'keeps the current assistant after %s', async (fallback) => {
      suggest.mockResolvedValue({ skill: null, probability: null, fallback, model: null })
      expect(await chooseJevPromptRoute({ message: 'A brand new task for you', assistants })).toMatchObject({
        assistantId: null, mode: null, fallback,
      })
    }
  )

  it('keeps the current assistant on a transport error', async () => {
    suggest.mockRejectedValue(new Error('unavailable'))
    expect(await chooseJevPromptRoute({ message: 'A brand new task for you', assistants })).toBeNull()
  })

  it('sends nothing when the user turned automatic routing off', async () => {
    useAutomationSettings.setState({ routeAssistants: false })
    try {
      expect(
        await chooseJevPromptRoute({ message: 'Fix this bug in the parser please', assistants })
      ).toBeNull()
      expect(suggest).not.toHaveBeenCalled()
    } finally {
      useAutomationSettings.setState({ routeAssistants: true })
    }
  })

  it('sends nothing for a pinned conversation, a temporary chat, or a short prompt', async () => {
    const base = { message: 'Fix this bug in the parser please', assistants }
    expect(await chooseJevPromptRoute({ ...base, pinned: true })).toBeNull()
    expect(await chooseJevPromptRoute({ ...base, temporary: true })).toBeNull()
    expect(await chooseJevPromptRoute({ ...base, message: 'fix it' })).toBeNull()
    expect(await chooseJevPromptRoute({ ...base, message: '/compact now please and thanks' })).toBeNull()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('stops waiting for Jev when the turn is aborted', async () => {
    suggest.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const pending = chooseJevPromptRoute({
      message: 'Fix this bug in the parser please',
      assistants,
      signal: controller.signal,
    })
    controller.abort()
    expect(await pending).toBeNull()
  })

  it('keeps custom assistants pinned without calling Jev', async () => {
    expect(await chooseJevPromptRoute({
      message: 'Fix this bug in the parser please', assistants, currentAssistantId: 'custom',
    })).toBeNull()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('does not switch assistants in shadow mode', async () => {
    useJevSettings.setState({ skillMode: 'shadow' })
    suggest.mockResolvedValue({ skill: null, probability: 0.9, fallback: 'shadow', model: 'jev' })
    expect(await chooseJevPromptRoute({ message: 'Fix this bug in the parser please', assistants })).toMatchObject({
      assistantId: null, mode: null,
    })
  })
})
