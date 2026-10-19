import { beforeEach, describe, expect, it } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

describe('queued mail keeps its backend hold across a restart', () => {
  beforeEach(() => useCoworkSessions.setState({ sessions: [], currentId: null }))

  it('persists from.hold so a held message is not auto-woken after reload', () => {
    const sid = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setPendingInput(sid, [
      {
        id: 'mail:m1',
        text: 'hi',
        createdAt: 1,
        held: true,
        from: {
          sessionId: 'B',
          displayName: 'B',
          messageId: 'm1',
          replyTo: null,
          depth: 3,
          hold: 'chain_wakes',
        },
      },
    ])
    const saved = useCoworkSessions.getState().sessions.find((s) => s.id === sid)
    expect(saved?.pendingInput?.[0].from?.hold).toBe('chain_wakes')
  })

  it('adds no hold key to mail that was not held', () => {
    const sid = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setPendingInput(sid, [
      {
        id: 'mail:m2',
        text: 'hi',
        createdAt: 1,
        held: true,
        from: { sessionId: 'B', displayName: 'B', messageId: 'm2', replyTo: null, depth: 1 },
      },
    ])
    const saved = useCoworkSessions.getState().sessions.find((s) => s.id === sid)
    expect(saved?.pendingInput?.[0].from).not.toHaveProperty('hold')
  })
})
