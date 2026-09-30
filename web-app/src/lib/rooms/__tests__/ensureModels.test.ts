import { beforeEach, describe, expect, it, vi } from 'vitest'

const prompt = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useModelReplacePrompt', () => ({ promptReplaceModels: prompt }))
vi.mock('@/lib/modelReplace', async (orig) => {
  const real = await orig<typeof import('@/lib/modelReplace')>()
  return {
    ...real,
    unavailableModels: (refs: ({ provider: string; id: string } | null)[]) =>
      refs.filter((r): r is { provider: string; id: string } => !!r && r.id.startsWith('gone')),
  }
})

import { modelKey } from '@/lib/modelReplace'
import { replaceMissingRoomModels } from '../ensureModels'

const participant = (id: string, model: string, removed = false) =>
  ({ id, name: id, role: '', model: { provider: 'p', id: model }, removed }) as never
const room = (over: object = {}) =>
  ({
    title: 'Test room',
    participants: [participant('a', 'ok'), participant('b', 'gone-1'), participant('c', 'gone-2', true)],
    moderator: { enabled: true, name: 'M', model: { provider: 'p', id: 'gone-mod' } },
    ...over,
  }) as never

beforeEach(() => prompt.mockReset())

describe('replaceMissingRoomModels', () => {
  it('asks for nothing when every model resolves', async () => {
    const out = await replaceMissingRoomModels(
      room({ participants: [participant('a', 'ok')], moderator: { enabled: false, model: null } })
    )
    expect(out).toEqual({})
    expect(prompt).not.toHaveBeenCalled()
  })

  it('asks about the speaking participants and the moderator, not a removed one', async () => {
    prompt.mockResolvedValue(null)
    await replaceMissingRoomModels(room())
    const missing = prompt.mock.calls[0][1] as { id: string }[]
    expect(missing.map((m) => m.id)).toEqual(['gone-1', 'gone-mod'])
  })

  it('returns null when the user cancels, so the room does not start', async () => {
    prompt.mockResolvedValue(null)
    expect(await replaceMissingRoomModels(room())).toBeNull()
  })

  it('swaps in the chosen models and leaves the rest as they were', async () => {
    const pick = { provider: 'p', id: 'fresh' }
    prompt.mockResolvedValue({
      [modelKey({ provider: 'p', id: 'gone-1' })]: pick,
      [modelKey({ provider: 'p', id: 'gone-mod' })]: pick,
    })
    const out = await replaceMissingRoomModels(room())
    expect(out?.participants?.map((p) => p.model.id)).toEqual(['ok', 'fresh', 'gone-2'])
    expect(out?.moderator?.model?.id).toBe('fresh')
  })
})
