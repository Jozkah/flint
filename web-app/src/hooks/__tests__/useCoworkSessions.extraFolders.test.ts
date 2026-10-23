import { beforeEach, describe, expect, it } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'

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
    useCoworkWorktrees.setState({ bySession: {} })
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

  it('are marked read-only and editable again one at a time', () => {
    const store = useCoworkSessions.getState()
    store.addExtraFolder('A', '/repo/b')
    store.addExtraFolder('A', '/repo/c')
    store.setExtraFolderWritable('A', '/repo/b', false)
    expect(get().readOnlyExtraFolders).toEqual(['/repo/b'])
    store.setExtraFolderWritable('A', '/repo/b/', true)
    expect(get().readOnlyExtraFolders).toEqual([])
  })

  it('leave the main folder’s mark derived until it is set', () => {
    const store = useCoworkSessions.getState()
    expect(get().mainFolderReadOnly).toBeUndefined()
    store.setMainFolderReadOnly('A', true)
    expect(get().mainFolderReadOnly).toBe(true)
    store.setMainFolderReadOnly('A', false)
    expect(get().mainFolderReadOnly).toBe(false)
    store.setMainFolderReadOnly('A', undefined)
    expect('mainFolderReadOnly' in get()).toBe(false)
  })

  it('forget a read-only mark when the folder is removed', () => {
    const store = useCoworkSessions.getState()
    store.addExtraFolder('A', '/repo/b')
    store.setExtraFolderWritable('A', '/repo/b', false)
    store.removeExtraFolder('A', '/repo/b')
    expect(get().readOnlyExtraFolders).toEqual([])
  })

  it('drop a folder that becomes the primary', () => {
    const store = useCoworkSessions.getState()
    store.addExtraFolder('A', '/repo/b')
    store.setFolder('A', '/repo/b')
    expect(get().folder).toBe('/repo/b')
    expect(get().extraFolders).toEqual([])
  })

  it('forgets previous project worktree when primary folder changes', () => {
    useCoworkWorktrees.setState({ bySession: { A: { path: '/old-worktree' } as never } })
    useCoworkSessions.getState().setFolder('A', '/repo/b')
    expect(useCoworkWorktrees.getState().recordFor('A')).toBeUndefined()
  })
})
