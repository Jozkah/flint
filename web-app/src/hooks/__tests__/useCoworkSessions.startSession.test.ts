import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkSessions } from '../useCoworkSessions'

/**
 * The store side of "New session": one press, at most one session, and the
 * one it returns is the one that is selected.
 */

const store = () => useCoworkSessions.getState()
const idle = { running: false, hasDraft: false }

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
})

describe('starting a session', () => {
  it('creates the first one', () => {
    const id = store().startSession(idle)
    expect(store().sessions).toHaveLength(1)
    expect(id).toBe(store().sessions[0].id)
  })

  it('selects what it returns, so the route cannot show the old session', () => {
    const id = store().startSession(idle)
    expect(store().currentId).toBe(id)
  })

  it('does nothing when the current session is still blank', () => {
    const first = store().startSession(idle)
    const again = store().startSession(idle)

    expect(again).toBe(first)
    expect(store().sessions).toHaveLength(1)
  })

  it('survives a burst of clicks without a trail of blanks', () => {
    // The guard is that each press re-reads the store: after the first, the
    // current session is blank, so every later press is a no-op.
    store().startSession(idle)
    const ids = Array.from({ length: 8 }, () => store().startSession(idle))

    expect(new Set(ids).size).toBe(1)
    expect(store().sessions).toHaveLength(1)
  })

  it('creates exactly one more once the session has content', () => {
    const first = store().startSession(idle)
    store().setMessages(first, [{ id: 'm1' } as never])

    const second = store().startSession(idle)

    expect(second).not.toBe(first)
    expect(store().sessions).toHaveLength(2)
    expect(store().currentId).toBe(second)
  })

  it('keeps a populated session from spawning two on a double click', () => {
    const first = store().startSession(idle)
    store().setMessages(first, [{ id: 'm1' } as never])

    store().startSession(idle)
    store().startSession(idle)

    // The second press lands on the blank session the first just made.
    expect(store().sessions).toHaveLength(2)
  })

  it('stays put rather than stranding an unsent draft', () => {
    const first = store().startSession(idle)
    store().setMessages(first, [{ id: 'm1' } as never])

    const again = store().startSession({ running: false, hasDraft: true })

    expect(again).toBe(first)
    expect(store().sessions).toHaveLength(1)
  })

  it('starts a fresh session when a run is in flight', () => {
    const first = store().startSession(idle)
    const second = store().startSession({ running: true, hasDraft: false })

    expect(second).not.toBe(first)
  })
})
