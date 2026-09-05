import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkSessions } from '../useCoworkSessions'
import { useFileActivity } from '../useFileActivity'

/**
 * The store side of "New session": one press, at most one session, and the
 * one it returns is the one that is selected.
 */

const store = () => useCoworkSessions.getState()
const idle = { running: false, hasDraft: false }

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
  useFileActivity.setState({ byConversation: {} })
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

describe('a session that only touched files', () => {
  /**
   * File activity is recorded as each operation settles, but turns only reach
   * the session when the run commits. A cancelled run — or one cut short by a
   * restart — therefore leaves a session with an empty transcript that has
   * already written to disk. Judged on the transcript alone it looks blank,
   * and "New session" would hand the user that same session back with someone
   * else's file history in it.
   */
  it('is not reused, even with no turns, messages or tabs', () => {
    const first = store().startSession(idle)
    expect(store().sessions[0].turns).toHaveLength(0)

    useFileActivity.getState().record(first, [
      {
        id: 'call:abc',
        path: 'src/index.ts',
        operation: 'write',
        seq: 1,
        at: 1,
        ok: true,
        origin: 'project',
      },
    ])

    const again = store().startSession(idle)
    expect(again).not.toBe(first)
    expect(store().sessions).toHaveLength(2)
  })

  it('still reuses a session whose activity belongs to a different one', () => {
    const first = store().startSession(idle)
    useFileActivity.getState().record('some-other-session', [
      {
        id: 'call:xyz',
        path: 'src/other.ts',
        operation: 'write',
        seq: 1,
        at: 1,
        ok: true,
        origin: 'project',
      },
    ])

    expect(store().startSession(idle)).toBe(first)
    expect(store().sessions).toHaveLength(1)
  })
})
