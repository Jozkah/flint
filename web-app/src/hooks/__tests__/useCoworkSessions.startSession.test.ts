import { useCoworkRun } from '@/hooks/useCoworkRun'
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

/**
 * Restoring the right Cowork session across surface switches and deletions.
 * These pin the store-side half of session restoration; the Chat-tab half is
 * covered by left-sidebar/__tests__/tabRestoration.test.tsx.
 */
describe('Cowork session restoration', () => {
  it('keeps the selected session across a surface switch', () => {
    const first = store().createSession()
    store().commitTurns(first, [{ role: 'user', content: 'keep me' }], [], [])
    const second = store().createSession()
    store().selectSession(first)
    // Leaving Cowork for Chat and coming back changes no store state, so the
    // selection the route reads on return is still the one the user left on.
    expect(store().currentId).toBe(first)
    // The blank one left behind is discarded rather than kept as an entry.
    expect(store().sessions.some((s) => s.id === second)).toBe(false)
  })

  it('does not replace an active first-response session on New session', () => {
    // A run is in flight: its session has no committed turns yet but must not
    // be reused. `startSession` creates a fresh one and leaves the running one.
    const running = store().createSession()
    useCoworkRun.getState().startRun(running, 'run-1')
    const fresh = store().startSession({ running: true, hasDraft: false })
    expect(fresh).not.toBe(running)
    expect(store().sessions.some((s) => s.id === running)).toBe(true)
  })

  it('an explicit new session survives a surface switch', () => {
    const previous = store().createSession()
    store().commitTurns(previous, [{ role: 'user', content: 'old' }], [], [])
    const fresh = store().startSession({ running: false, hasDraft: false })
    expect(store().currentId).toBe(fresh)
    store().selectSession(fresh) // returning from Chat
    expect(store().currentId).toBe(fresh)
  })

  it('falls back to a remaining session when the current one is deleted', () => {
    const older = store().createSession()
    store().commitTurns(older, [{ role: 'user', content: 'older' }], [], [])
    const current = store().createSession()
    store().selectSession(current)
    store().deleteSession(current)
    // Not left pointing at nothing while other sessions exist.
    expect(store().currentId).not.toBeNull()
    expect(store().sessions.some((s) => s.id === store().currentId!)).toBe(true)
  })

  it('clears the selection when the last session is deleted', () => {
    const only = store().createSession()
    store().selectSession(only)
    store().deleteSession(only)
    expect(store().currentId).toBeNull()
  })
})
