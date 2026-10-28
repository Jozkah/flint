import { describe, expect, it } from 'vitest'
import { useCoworkSessions, type CoworkSession } from '../useCoworkSessions'

type Persisted = { partialize: (s: unknown) => { sessions: CoworkSession[] } }

const options = () =>
  (
    useCoworkSessions as unknown as {
      persist: { getOptions: () => Persisted }
    }
  ).persist.getOptions()

const session = (over: Partial<CoworkSession> = {}) =>
  ({
    id: 's1',
    title: 'one',
    turns: [],
    messages: [],
    mode: 'ask',
    ...over,
  }) as unknown as CoworkSession

describe('what a flush writes for a session', () => {
  it('reuses the result for a session object that did not change', () => {
    const a = session()
    const first = options().partialize({ sessions: [a] }).sessions[0]
    const second = options().partialize({ sessions: [a] }).sessions[0]
    expect(second).toBe(first)
  })

  it('computes again for a replaced session object', () => {
    const a = session()
    const first = options().partialize({ sessions: [a] }).sessions[0]
    const second = options().partialize({
      sessions: [{ ...a, title: 'two' }],
    }).sessions[0]
    expect(second).not.toBe(first)
    expect(second.title).toBe('two')
  })

  it('never writes bypass mode, and empties a server session pointer', () => {
    const out = options().partialize({
      sessions: [
        session({ id: 'b', mode: 'bypass' }),
        session({
          id: 'r',
          remote: { server: 'x', id: 'y' },
          messages: [{ id: 'm', role: 'user', parts: [] }],
        } as unknown as Partial<CoworkSession>),
      ],
    }).sessions
    expect(out[0].mode).toBe('ask')
    expect(out[1].messages).toEqual([])
    expect(out[1].turns).toEqual([])
  })
})
