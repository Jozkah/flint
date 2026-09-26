import { beforeEach, describe, expect, it } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

describe('blank sessions do not pile up', () => {
  beforeEach(() => useCoworkSessions.setState({ sessions: [], currentId: null }))

  it('leaving a blank session for an older one discards it', () => {
    const store = useCoworkSessions.getState()
    const old = store.createSession()
    store.setTitle(old, 'fix the build')
    for (let i = 0; i < 3; i++) {
      useCoworkSessions.getState().createSession()
      useCoworkSessions.getState().selectSession(old)
    }
    expect(useCoworkSessions.getState().sessions.map((s) => s.id)).toEqual([old])
  })

  it('a new session replaces the blank one before it', () => {
    useCoworkSessions.getState().createSession()
    const second = useCoworkSessions.getState().createSession()
    expect(useCoworkSessions.getState().sessions.map((s) => s.id)).toEqual([second])
  })
})
