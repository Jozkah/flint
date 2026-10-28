import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      disk.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      disk.delete(key)
    }),
  },
}))

import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { localStorageKey } from '@/constants/localStorage'
import { flushDeferredStores } from '@/lib/deferredPersistStorage'

const KEY = localStorageKey.coworkSessions

// Two sessions with content (a blank one is reused by createSession).
function twoSessions(): [string, string] {
  const a = useCoworkSessions.getState().createSession()
  const first = useCoworkSessions.getState().sessions.find((x) => x.id === a)!
  useCoworkSessions.setState((state) => ({
    sessions: [...state.sessions, { ...first, id: `${a}-b`, title: 'second' }],
  }))
  return [a, `${a}-b`]
}

beforeEach(async () => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
  await flushDeferredStores()
  disk.clear()
})

describe('Cowork sessions are saved one key each', () => {
  it('writes an index plus a shard per session, and a remote transcript is dropped', async () => {
    const [a, b] = twoSessions()
    useCoworkSessions.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === b
          ? {
              ...session,
              remote: true,
              turns: [{ role: 'user', content: 'secret transcript' }],
              messages: [],
            }
          : session
      ),
    }))
    await flushDeferredStores()

    const index = JSON.parse(disk.get(KEY)!)
    expect(index.state.sessions).toBeUndefined()
    expect(index.state.sessionIds).toEqual(expect.arrayContaining([a, b]))
    const shard = JSON.parse(disk.get(`${KEY}:${b}`)!)
    expect(shard.state.sessions[0].turns).toEqual([])
    expect(disk.has(`${KEY}:${a}`)).toBe(true)
  })

  it('a change to one session rewrites only that shard', async () => {
    const [a, b] = twoSessions()
    await flushDeferredStores()
    const before = disk.get(`${KEY}:${a}`)
    disk.set(`${KEY}:${a}`, 'sentinel')
    useCoworkSessions.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === b ? { ...session, title: 'renamed' } : session
      ),
    }))
    await flushDeferredStores()
    expect(before).toBeDefined()
    expect(disk.get(`${KEY}:${a}`)).toBe('sentinel')
    expect(JSON.parse(disk.get(`${KEY}:${b}`)!).state.sessions[0].title).toBe('renamed')
  })
})
