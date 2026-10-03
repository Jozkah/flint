import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  distinctModels,
  ensureKnownWindows,
  hasUnknownWindow,
  participantsWithUnknownWindow,
  resetAcceptedWindows,
  saveMaxContextTokens,
} from '../unknownWindows'
import type { ProviderLookup } from '../availability'
import { makeParticipant, makeRoom } from '../../../containers/rooms/__tests__/roomsTestUtils'

const prompt = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useUnknownWindowPrompt', () => ({ promptUnknownWindows: prompt }))

const userSet = (value: unknown) => ({
  max_context_tokens: { controller_props: { value } },
})

const providers = [
  {
    provider: 'custom',
    active: true,
    api_key: 'k',
    models: [
      { id: 'mystery' },
      { id: 'mystery-zero', settings: userSet(0) },
      { id: 'sized', settings: userSet(64000) },
    ],
  },
]
const lookup: ProviderLookup = (name) => providers.find((p) => p.provider === name) as never

const on = (id: string) => ({ provider: 'custom', id })

beforeEach(() => {
  prompt.mockReset()
  resetAcceptedWindows()
  useModelProvider.setState({ providers: JSON.parse(JSON.stringify(providers)) } as never)
})

describe('hasUnknownWindow', () => {
  it('is true with no setting and no known window', () => {
    expect(hasUnknownWindow(on('mystery'), lookup)).toBe(true)
  })
  it('treats 0 (trimming disabled) as not set', () => {
    expect(hasUnknownWindow(on('mystery-zero'), lookup)).toBe(true)
  })
  it('is false when Max Context Tokens is set', () => {
    expect(hasUnknownWindow(on('sized'), lookup)).toBe(false)
  })
  it('leaves a model that cannot be found to the replace flow', () => {
    expect(hasUnknownWindow(on('gone'), lookup)).toBe(false)
  })
})

describe('participantsWithUnknownWindow', () => {
  it('lists participants and a distinct moderator whose window is unknown', () => {
    const room = makeRoom({
      participants: [
        makeParticipant('p1', { name: 'Alice', model: on('mystery') }),
        makeParticipant('p2', { name: 'Bob', model: on('sized') }),
        makeParticipant('p3', { name: 'Cy', model: on('mystery'), removed: true } as never),
      ],
      moderator: { enabled: true, name: 'Mod', model: on('mystery-zero') },
    })
    const list = participantsWithUnknownWindow(room, lookup)
    expect(list.map((e) => [e.id, e.name, e.model.id])).toEqual([
      ['p1', 'Alice', 'mystery'],
      ['moderator', 'Moderator', 'mystery-zero'],
    ])
  })
  it('ignores a disabled moderator and is empty when all windows are known', () => {
    const room = makeRoom({
      participants: [makeParticipant('p1', { model: on('sized') })],
      moderator: { enabled: false, name: 'Mod', model: on('mystery') },
    })
    expect(participantsWithUnknownWindow(room, lookup)).toEqual([])
  })
  it('distinctModels collapses a shared model', () => {
    const room = makeRoom({
      participants: [
        makeParticipant('p1', { model: on('mystery') }),
        makeParticipant('p2', { model: on('mystery') }),
      ],
    })
    const list = participantsWithUnknownWindow(room, lookup)
    expect(list).toHaveLength(2)
    expect(distinctModels(list)).toEqual([on('mystery')])
  })
})

describe('ensureKnownWindows', () => {
  const unknownRoom = () =>
    makeRoom({
      participants: [
        makeParticipant('p1', { model: on('mystery') }),
        makeParticipant('p2', { model: on('sized') }),
      ],
    })

  it('does not ask when every window is known', async () => {
    const room = makeRoom({ participants: [makeParticipant('p1', { model: on('sized') })] })
    expect(await ensureKnownWindows(room, lookup)).toBe(true)
    expect(prompt).not.toHaveBeenCalled()
  })
  it('asks, and returns false when the user cancels', async () => {
    prompt.mockResolvedValue(false)
    expect(await ensureKnownWindows(unknownRoom(), lookup)).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][1].map((e: { id: string }) => e.id)).toEqual(['p1'])
  })
  it('returns true once the user resolves them', async () => {
    prompt.mockResolvedValue(true)
    expect(await ensureKnownWindows(unknownRoom(), lookup)).toBe(true)
  })
})

describe('saveMaxContextTokens', () => {
  it('writes the model setting in the shape the settings sheet uses', () => {
    saveMaxContextTokens(on('mystery'), 16000)
    const m = useModelProvider.getState().providers[0].models.find((x) => x.id === 'mystery')
    expect(m?.settings?.max_context_tokens?.controller_props?.value).toBe(16000)
    const live: ProviderLookup = (n) => useModelProvider.getState().getProviderByName(n)
    expect(hasUnknownWindow(on('mystery'), live)).toBe(false)
  })
})
