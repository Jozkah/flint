import { describe, it, expect, beforeEach } from 'vitest'
import { useCoworkSessions } from '../useCoworkSessions'
import type { SessionBundle } from '@/lib/sessionBundle'
import type { HandoffRecord } from '@/lib/sessionHandoff'

const bundle = (exportId: string): SessionBundle => ({
  format: 'jan.cowork-session',
  schemaVersion: 1,
  exportId,
  exportedAt: '2026-09-10T00:00:00Z',
  session: { id: 'remote', title: 'Trip', turns: [], updated: 1 },
  toolActivity: [],
  fileActivity: [],
  changeSummary: [],
})

const record: HandoffRecord = {
  info: { folder: { name: 'widget' }, model: null },
  unrestored: [{ kind: 'folder', expected: { name: 'widget' } }],
}

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
})

describe('importing a handoff (AH-210)', () => {
  it('keeps what could not be restored on the new, unbound session', () => {
    const out = useCoworkSessions.getState().importSession(bundle('h1'), record)
    expect(out.ok).toBe(true)
    const session = useCoworkSessions.getState().sessions[0]
    expect(session.handoff).toEqual(record)
    // The folder is named, never attached for the user.
    expect(session.folder).toBeNull()
    expect(session.access).toBeUndefined()
  })

  it('remembers that the notice was dismissed', () => {
    const out = useCoworkSessions.getState().importSession(bundle('h2'), record)
    if (!out.ok) throw new Error('import failed')
    useCoworkSessions.getState().dismissHandoff(out.id)
    expect(useCoworkSessions.getState().sessions[0].handoff?.dismissed).toBe(
      true
    )
  })

  it('imports an ordinary export with no handoff record', () => {
    const out = useCoworkSessions.getState().importSession(bundle('e1'))
    expect(out.ok).toBe(true)
    expect(useCoworkSessions.getState().sessions[0].handoff).toBeUndefined()
  })
})
