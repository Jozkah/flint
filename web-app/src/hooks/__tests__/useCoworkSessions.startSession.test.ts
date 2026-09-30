import { useCoworkRun } from '@/hooks/useCoworkRun'
import { usePrompt } from '@/hooks/usePrompt'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { startPaneSession, startPaneSessionParked, useCoworkSessions } from '../useCoworkSessions'
import { useFileActivity } from '../useFileActivity'

/**
 * The store side of "New session": one press, at most one session, and the
 * one it returns is the one that is selected.
 */

const store = () => useCoworkSessions.getState()
const idle = { running: false }

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
  useFileActivity.setState({ byConversation: {} })
  usePrompt.setState({
    prompt: '',
    historyIndex: -1,
    draftPrompt: '',
    scoped: {},
  })
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

  it('parks an unsent draft on the session it was typed in', () => {
    const first = store().startSession(idle)
    store().setMessages(first, [{ id: 'm1' } as never])


    const again = store().startSession({ running: false, draft: 'draft text' })

    expect(again).not.toBe(first)
    expect(store().sessions).toHaveLength(2)
    expect(store().currentId).toBe(again)
    // The draft survives, held on the old session for the user to send or
    // discard.
    expect(store().sessions.find((s) => s.id === first)?.pendingInput).toEqual([
      expect.objectContaining({ text: 'draft text' }),
    ])
  })

  it('reuses a blank session and leaves the draft in the composer', () => {
    const first = store().startSession(idle)

    const again = store().startSessionParked({ running: false, draft: 'draft text' })

    // Parked on a blank session the draft would be hidden with it.
    expect(again).toEqual({ id: first, parked: false })
    expect(store().sessions).toHaveLength(1)
    expect(store().sessions[0].pendingInput).toBeUndefined()
  })

  it('reports that a draft was parked only when it was', () => {
    const first = store().startSession(idle)
    store().setMessages(first, [{ id: 'm1' } as never])

    expect(store().startSessionParked({ running: false, draft: 'kept' })).toMatchObject({
      parked: true,
    })
    const [latest] = store().sessions
    expect(store().startSessionParked({ running: false, draft: '   ' })).toEqual({
      id: latest.id,
      parked: false,
    })
  })

  it('does not report a draft as parked when there is no session to park it on', () => {
    const out = store().startSessionParked({ running: false, draft: 'orphan' })
    expect(out.parked).toBe(false)
    expect(store().sessions).toHaveLength(1)
  })

  it('reports parked from a pane too, and not for a blank pane session', () => {
    const pane = store().createSession()
    expect(
      startPaneSessionParked(pane, { running: false, draft: 'blank pane draft' })
    ).toEqual({ id: pane, parked: false })

    store().setMessages(pane, [{ id: 'm' } as never])
    const out = startPaneSessionParked(pane, { running: false, draft: 'pane draft' })
    expect(out.parked).toBe(true)
    expect(store().sessions.find((s) => s.id === pane)?.pendingInput).toEqual([
      expect.objectContaining({ text: 'pane draft' }),
    ])
  })

  it('does not park a whitespace-only draft', () => {
    const first = store().startSession(idle)
    store().setMessages(first, [{ id: 'm1' } as never])

    const again = store().startSession({ running: false, draft: '   ' })

    expect(again).not.toBe(first)
    expect(store().sessions.find((s) => s.id === first)?.pendingInput).toBeUndefined()
  })

  it('keeps existing held input when parking a draft', () => {
    const first = store().startSession(idle)
    store().setMessages(first, [{ id: 'm1' } as never])
    store().setPendingInput(first, [
      { id: 'held-1', text: 'already held', createdAt: 1 },
    ])

    store().startSession({ running: false, draft: 'new draft' })

    expect(store().sessions.find((s) => s.id === first)?.pendingInput).toEqual([
      { id: 'held-1', text: 'already held', createdAt: 1 },
      expect.objectContaining({ text: 'new draft' }),
    ])
  })

  it('starts a fresh session when a run is in flight', () => {
    const first = store().startSession(idle)
    const second = store().startSession({ running: true })

    expect(second).not.toBe(first)
  })

  it('parks only the scoped pane draft, leaving the main composer alone', () => {
    const main = store().startSession(idle)
    const pane = store().createSession()
    store().setMessages(pane, [{ id: 'pane-message' } as never])
    store().selectSession(main)
    usePrompt.getState().setPrompt('main draft')
    usePrompt.getState().setScopedPrompt('split:secondary', 'pane draft')

    const next = startPaneSession(pane, {
      running: false,
      draft: usePrompt.getState().scoped['split:secondary'].prompt,
    })

    expect(next).not.toBe(pane)
    expect(store().sessions.find((s) => s.id === pane)?.pendingInput).toEqual([
      expect.objectContaining({ text: 'pane draft' }),
    ])
    expect(
      store().sessions.find((s) => s.id === main)?.pendingInput
    ).toBeUndefined()
    expect(usePrompt.getState().prompt).toBe('main draft')
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
    const fresh = store().startSession({ running: true })
    expect(fresh).not.toBe(running)
    expect(store().sessions.some((s) => s.id === running)).toBe(true)
  })

  it('an explicit new session survives a surface switch', () => {
    const previous = store().createSession()
    store().commitTurns(previous, [{ role: 'user', content: 'old' }], [], [])
    const fresh = store().startSession({ running: false })
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
