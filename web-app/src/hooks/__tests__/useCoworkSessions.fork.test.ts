/**
 * AH-201: forking a session.
 *
 * The authority rules are the point. A fork that inherited a folder, a grant
 * or a consent would let someone multiply what they were given once by
 * forking, and would put two sessions on one checkout without either knowing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}))

import { useCoworkSessions } from '../useCoworkSessions'
import type { CoworkTurn } from '@/types/coworkSession'

const turn = (content: string, role: CoworkTurn['role'] = 'user'): CoworkTurn => ({
  role,
  content,
})

const seed = (turns: CoworkTurn[]) => {
  const id = useCoworkSessions.getState().createSession()
  useCoworkSessions.setState((s) => ({
    sessions: s.sessions.map((x) =>
      x.id === id
        ? {
            ...x,
            title: 'Parent',
            turns,
            folder: '/repo',
            access: 'direct' as never,
            editConsent: { sessionId: id, folder: '/repo' } as never,
            mode: 'auto' as never,
          }
        : x
    ),
  }))
  return id
}

const sessionById = (id: string | null) =>
  useCoworkSessions.getState().sessions.find((s) => s.id === id)

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
})

describe('what a fork carries', () => {
  it('copies the conversation up to the turn it was forked at', () => {
    const parent = seed([turn('one'), turn('two', 'assistant'), turn('three')])
    const forkId = useCoworkSessions.getState().forkSession(parent, 2)
    const fork = sessionById(forkId)

    expect(fork?.turns.map((t) => t.content)).toEqual(['one', 'two'])
    // The parent is untouched.
    expect(sessionById(parent)?.turns).toHaveLength(3)
  })

  it('forks the whole conversation when no turn is named', () => {
    const parent = seed([turn('one'), turn('two')])
    const fork = sessionById(useCoworkSessions.getState().forkSession(parent))
    expect(fork?.turns).toHaveLength(2)
  })

  it('records where it came from and where it diverged', () => {
    const parent = seed([turn('one'), turn('two')])
    const fork = sessionById(useCoworkSessions.getState().forkSession(parent, 1))
    expect(fork?.forkedFrom).toMatchObject({ sessionId: parent, turns: 1 })
    expect(typeof fork?.forkedFrom?.at).toBe('number')
  })

  it('rebuilds its own messages rather than slicing the parent’s', () => {
    const parent = seed([turn('one'), turn('two', 'assistant')])
    const fork = sessionById(useCoworkSessions.getState().forkSession(parent, 2))
    expect(fork?.messages.length).toBeGreaterThan(0)
    // Ids are the fork's own, so nothing is keyed to the parent.
    expect(fork?.messages.every((m) => m.id.startsWith(fork.id))).toBe(true)
  })
})

describe('what a fork does not carry', () => {
  it('inherits no authority at all', () => {
    const parent = seed([turn('one')])
    const fork = sessionById(useCoworkSessions.getState().forkSession(parent, 1))

    // A fork that inherited these would multiply authority given once.
    expect(fork?.folder).toBe(null)
    expect(fork?.access).toBeUndefined()
    expect(fork?.editConsent).toBeUndefined()
    expect(fork?.runBudget).toBeUndefined()
    // The parent keeps everything it had.
    expect(sessionById(parent)?.folder).toBe('/repo')
    expect(sessionById(parent)?.editConsent).toBeDefined()
  })
})

describe('refusals', () => {
  it('refuses to fork a session that does not exist', () => {
    expect(useCoworkSessions.getState().forkSession('nobody')).toBe(null)
  })

  it('refuses a divergence point outside the conversation', () => {
    const parent = seed([turn('one')])
    const fork = useCoworkSessions.getState()
    // Refused rather than clamped: a fork silently taken at a different turn
    // is not the fork that was asked for.
    expect(fork.forkSession(parent, 5)).toBe(null)
    expect(fork.forkSession(parent, -1)).toBe(null)
    expect(fork.forkSession(parent, 1.5)).toBe(null)
    expect(useCoworkSessions.getState().sessions).toHaveLength(1)
  })
})

describe('afterwards', () => {
  it('leaves both sessions independently usable and deletable', () => {
    const parent = seed([turn('one'), turn('two')])
    const forkId = useCoworkSessions.getState().forkSession(parent, 1)!

    useCoworkSessions.getState().setTitle(forkId, 'Fork renamed')
    expect(sessionById(parent)?.title).toBe('Parent')

    useCoworkSessions.getState().deleteSession(parent)
    // The fork survives its parent, and still says where it came from.
    expect(sessionById(forkId)?.forkedFrom?.sessionId).toBe(parent)
    expect(sessionById(parent)).toBeUndefined()
  })

  it('shows the fork, so the user is where the work continues', () => {
    const parent = seed([turn('one')])
    const forkId = useCoworkSessions.getState().forkSession(parent, 1)
    expect(useCoworkSessions.getState().currentId).toBe(forkId)
  })
})
