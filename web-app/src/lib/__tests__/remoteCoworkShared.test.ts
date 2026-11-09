import { beforeEach, describe, expect, it } from 'vitest'
import { commitTurns, endingFor, live, titleUpdate } from '../remoteCoworkShared'
import { remoteRunFor } from '../remoteCowork'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import type { RemoteRun } from '../remoteRun'
import type { CoworkTurn } from '@/types/coworkSession'

// What remoteCowork.ts and remoteRun.ts share now that the run mirror lives
// in its own module.
describe('remoteCoworkShared', () => {
  beforeEach(() => {
    live.clear()
    useCoworkSessions.setState({
      sessions: [
        { id: 'srv-1', title: 'srv-1', folder: null, turns: [], messages: [], updated: 1 },
      ] as unknown as CoworkSession[],
    })
  })

  it('reads a turn end in the route vocabulary', () => {
    expect(endingFor({ stopReason: 'interrupted' })).toEqual({ stoppedBy: 'aborted' })
    expect(endingFor({ stopReason: 'error' })).toEqual({
      stoppedBy: 'error',
      errorText: 'The server run failed.',
    })
    expect(endingFor({ error: 'boom' })).toEqual({ stoppedBy: 'error', errorText: 'boom' })
    expect(endingFor({ stopReason: 'done' })).toBeNull()
  })

  it('titles a placeholder row from the first thing said, and keeps a real title', () => {
    const turns = [{ role: 'user', content: 'Fix the login\nmore' }] as CoworkTurn[]
    expect(titleUpdate({ id: 'x', title: 'x' }, undefined, turns)).toEqual({
      title: 'Fix the login',
    })
    expect(titleUpdate({ id: 'x', title: 'Mine' }, undefined, turns)).toEqual({})
    expect(titleUpdate({ id: 'x', title: 'Mine' }, 'Server named', turns)).toEqual({
      title: 'Server named',
    })
  })

  it('commits a transcript onto its row only', () => {
    const turns = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ] as CoworkTurn[]
    commitTurns('srv-1', turns, { folder: '/srv/repo' })
    const row = useCoworkSessions.getState().sessions[0]
    expect(row.turns).toBe(turns)
    expect(row.messages.length).toBeGreaterThan(0)
    expect(row.folder).toBe('/srv/repo')
    expect(row.title).toBe('hello')
    commitTurns('other', [])
    expect(useCoworkSessions.getState().sessions[0]).toBe(row)
  })

  it('is the one map of followed runs both modules read', () => {
    expect(remoteRunFor('srv-1')).toBeUndefined()
    live.set('srv-1', { runId: 'r1' } as RemoteRun)
    expect(remoteRunFor('srv-1')).toEqual({ runId: 'r1' })
  })
})
