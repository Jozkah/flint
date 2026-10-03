import { beforeEach, describe, expect, it } from 'vitest'
import { createJSONStorage } from 'zustand/middleware'
import { useContextBreakdown } from '../useContextBreakdown'

const empty = { byId: {}, windowById: {}, windowModelById: {}, lastById: {} }

describe('useContextBreakdown', () => {
  beforeEach(() => {
    useContextBreakdown.setState(empty)
  })

  it('remembers what a chat last showed, with its model and age', () => {
    useContextBreakdown.getState().setLast('t', { used: 25_500, window: 262_144, model: 'm', at: 5 })
    expect(useContextBreakdown.getState().lastById.t).toEqual({
      used: 25_500,
      window: 262_144,
      model: 'm',
      at: 5,
    })
  })

  it('keeps the model a window belongs to', () => {
    useContextBreakdown.getState().setWindow('t', 262_144, 'm')
    expect(useContextBreakdown.getState().windowById.t).toBe(262_144)
    expect(useContextBreakdown.getState().windowModelById.t).toBe('m')
  })

  it('stays bounded, dropping the chats untouched longest', () => {
    const { setLast } = useContextBreakdown.getState()
    for (let i = 0; i < 350; i++) setLast(`t${i}`, { used: i, at: i })
    const ids = Object.keys(useContextBreakdown.getState().lastById)
    expect(ids).toHaveLength(300)
    expect(ids).not.toContain('t0')
    expect(ids).toContain('t349')
  })

  it('forgets a chat entirely when it is cleared', () => {
    const s = useContextBreakdown.getState()
    s.setLast('t', { used: 1, at: 1 })
    s.setWindow('t', 10, 'm')
    s.clear('t')
    const after = useContextBreakdown.getState()
    expect(after.lastById.t).toBeUndefined()
    expect(after.windowById.t).toBeUndefined()
    expect(after.windowModelById.t).toBeUndefined()
  })

  it('survives a restart: written out, and read back by a fresh store', async () => {
    const memory = new Map<string, string>()
    const storage = createJSONStorage(() => ({
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    }))
    useContextBreakdown.persist.setOptions({ storage })
    useContextBreakdown.getState().setLast('t', { used: 25_500, window: 262_144, model: 'm', at: 1 })
    useContextBreakdown.getState().setWindow('t', 262_144, 'm')
    await Promise.resolve()
    expect(memory.size).toBe(1)

    // The app restarts: in-memory state is gone, storage is not.
    const saved = new Map(memory)
    useContextBreakdown.setState(empty)
    saved.forEach((v, k) => memory.set(k, v))
    await useContextBreakdown.persist.rehydrate()
    const back = useContextBreakdown.getState()
    expect(back.lastById.t).toMatchObject({ used: 25_500, window: 262_144, model: 'm' })
    expect(back.windowById.t).toBe(262_144)
    expect(back.windowModelById.t).toBe('m')
  })
})
