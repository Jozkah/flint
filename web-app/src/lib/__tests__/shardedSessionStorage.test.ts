import { describe, expect, it, vi } from 'vitest'
import type { StateStorage } from 'zustand/middleware'
import { shardedSessionStorage } from '../shardedSessionStorage'

type S = { sessions: Array<{ id: string; title: string }>; currentId: string | null }

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const inner = {
    getItem: vi.fn(async (k: string) => data.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      data.set(k, v)
    }),
    removeItem: vi.fn(async (k: string) => {
      data.delete(k)
    }),
  }
  return { data, inner: inner as StateStorage & typeof inner }
}

const sessions = (...ids: string[]) => ids.map((id) => ({ id, title: `t-${id}` }))
const value = (s: S['sessions'], currentId: string | null = null) => ({
  state: { sessions: s, currentId } as S,
  version: 5,
})

describe('shardedSessionStorage', () => {
  it('writes only the changed session after one session changes', async () => {
    const { inner } = memory()
    const store = shardedSessionStorage<S>(inner)
    await store.setItem('k', value(sessions('a', 'b', 'c')))
    inner.setItem.mockClear()
    const next = sessions('a', 'b', 'c')
    next[1] = { id: 'b', title: 'changed' }
    await store.setItem('k', value(next))
    const keys = inner.setItem.mock.calls.map((c) => c[0])
    expect(keys).toEqual(['k:b', 'k'])
  })

  it('round-trips order and fields', async () => {
    const { inner } = memory()
    const a = shardedSessionStorage<S>(inner)
    await a.setItem('k', value(sessions('c', 'a', 'b'), 'a'))
    const b = shardedSessionStorage<S>(inner)
    const read = await b.getItem('k')
    expect(read?.state.sessions.map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(read?.state.currentId).toBe('a')
    expect(read?.version).toBe(5)
    expect(read?.state).not.toHaveProperty('sessionIds')
  })

  it('reads a legacy single blob and the next write converts it to shards plus a slim index', async () => {
    const legacy = JSON.stringify(value(sessions('x', 'y'), 'x'))
    const { inner, data } = memory({ k: legacy })
    const store = shardedSessionStorage<S>(inner)
    const read = await store.getItem('k')
    expect(read?.state.sessions.map((s) => s.id)).toEqual(['x', 'y'])
    await store.setItem('k', read!)
    expect(data.has('k:x')).toBe(true)
    expect(data.has('k:y')).toBe(true)
    const index = JSON.parse(data.get('k')!)
    expect(index.state.sessions).toBeUndefined()
    expect(index.state.sessionIds).toEqual(['x', 'y'])
  })

  it("a removed session's shard is deleted after the index write", async () => {
    const { inner, data } = memory()
    const store = shardedSessionStorage<S>(inner)
    await store.setItem('k', value(sessions('a', 'b')))
    const order: string[] = []
    inner.setItem.mockImplementation(async (k: string, v: string) => {
      order.push(`set:${k}`)
      data.set(k, v)
    })
    inner.removeItem.mockImplementation(async (k: string) => {
      order.push(`rm:${k}`)
      data.delete(k)
    })
    await store.setItem('k', value(sessions('a')))
    expect(data.has('k:b')).toBe(false)
    expect(order.indexOf('rm:k:b')).toBeGreaterThan(order.indexOf('set:k'))
  })

  it('a crash after the shards but before the index leaves the previous data readable', async () => {
    const legacy = JSON.stringify(value(sessions('x', 'y'), 'x'))
    const { inner } = memory({ k: legacy })
    const store = shardedSessionStorage<S>(inner)
    const read = await store.getItem('k')
    const real = inner.setItem.getMockImplementation()!
    inner.setItem.mockImplementation(async (k: string, v: string) => {
      if (k === 'k') throw new Error('crash')
      return real(k, v)
    })
    await expect(store.setItem('k', read!)).rejects.toThrow('crash')
    inner.setItem.mockImplementation(real)
    const again = await shardedSessionStorage<S>(inner).getItem('k')
    expect(again?.state.sessions.map((s) => s.id)).toEqual(['x', 'y'])
  })

  it('a missing shard is skipped, not fatal, and is never deleted by a later write', async () => {
    const { inner, data } = memory()
    const writer = shardedSessionStorage<S>(inner)
    await writer.setItem('k', value(sessions('a', 'b', 'c')))
    data.delete('k:b')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = shardedSessionStorage<S>(inner)
    const read = await store.getItem('k')
    expect(read?.state.sessions.map((s) => s.id)).toEqual(['a', 'c'])
    expect(warn).toHaveBeenCalled()
    await store.setItem('k', read!)
    expect(JSON.parse(data.get('k')!).state.sessionIds).toEqual(['a', 'c', 'b'])
    warn.mockRestore()
  })

  it('a shard whose read threw keeps its data', async () => {
    const { inner, data } = memory()
    await shardedSessionStorage<S>(inner).setItem('k', value(sessions('a', 'b')))
    const real = inner.getItem.getMockImplementation()!
    inner.getItem.mockImplementation(async (k: string) => {
      if (k === 'k:b') throw new Error('io')
      return real(k)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = shardedSessionStorage<S>(inner)
    const read = await store.getItem('k')
    expect(read?.state.sessions.map((s) => s.id)).toEqual(['a'])
    await store.setItem('k', read!)
    expect(data.has('k:b')).toBe(true)
  })

  it('falls back to the single blob when sessions cannot be keyed', async () => {
    const { inner, data } = memory()
    const store = shardedSessionStorage<S>(inner)
    await store.setItem('k', value([{ id: 'a', title: '1' }, { id: 'a', title: '2' }]))
    expect(JSON.parse(data.get('k')!).state.sessions).toHaveLength(2)
    expect(inner.setItem).toHaveBeenCalledTimes(1)
  })

  it('removeItem drops the index and the shards', async () => {
    const { inner, data } = memory()
    const store = shardedSessionStorage<S>(inner)
    await store.setItem('k', value(sessions('a', 'b')))
    await store.removeItem('k')
    expect([...data.keys()]).toEqual([])
  })
})
