import { beforeEach, describe, expect, it } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

const session = (id: string) =>
  ({
    id,
    title: id,
    folder: '/repo/a',
    turns: [],
    messages: [],
    subagents: [],
    access: 'edit-folder',
    editConsent: { sessionId: id, folder: '/repo/a' },
    created: 1,
    updated: 1,
  }) as never

const get = () => useCoworkSessions.getState().sessions[0]

describe('a session’s extra folders', () => {
  beforeEach(() => {
    useCoworkSessions.setState({ sessions: [session('A')], currentId: 'A' })
  })

  it('are added beside the primary, which stays the folder', () => {
    const store = useCoworkSessions.getState()
    store.addExtraFolder('A', '/repo/b')
    store.addExtraFolder('A', '/repo/c')
    store.addExtraFolder('A', '/repo/a')
    expect(get().folder).toBe('/repo/a')
    expect(get().extraFolders).toEqual(['/repo/b', '/repo/c'])
  })

  it('withdraw the access agreed for the old set when they change', () => {
    useCoworkSessions.getState().addExtraFolder('A', '/repo/b')
    expect(get().access).toBe('review-only')
    expect(get().editConsent).toBeUndefined()
  })

  it('are removed one at a time', () => {
    const store = useCoworkSessions.getState()
    store.addExtraFolder('A', '/repo/b')
    store.addExtraFolder('A', '/repo/c')
    store.removeExtraFolder('A', '/repo/b')
    expect(get().extraFolders).toEqual(['/repo/c'])
  })

  it('drop a folder that becomes the primary', () => {
    const store = useCoworkSessions.getState()
    store.addExtraFolder('A', '/repo/b')
    store.setFolder('A', '/repo/b')
    expect(get().folder).toBe('/repo/b')
    expect(get().extraFolders).toEqual([])
  })
})
