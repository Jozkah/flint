import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: {
    getState: () => ({
      sessions: [
        { id: 's1', folder: 'C:/code/app', extraFolders: ['C:/code/lib', ''] },
        { id: 's2', folder: null },
      ],
    }),
  },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: {
    getState: () => ({
      threads: {
        t1: { id: 't1', metadata: { folders: ['C:/code/app', 'C:/code/docs'] } },
        t2: { id: 't2' },
      },
    }),
  },
}))

import { foldersInUse, grandfatherFolderTrust } from '../grandfatherFolderTrust'
import { toast } from 'sonner'

describe('the first-run folder trust migration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('collects the folders of sessions and chats once each', () => {
    expect(foldersInUse().sort()).toEqual(['C:/code/app', 'C:/code/docs', 'C:/code/lib'])
  })

  it('hands them to the backend and says how many were kept', async () => {
    const call = vi.fn().mockResolvedValue(['c:/code/app', 'c:/code/lib'])
    const kept = await grandfatherFolderTrust(['C:/code/app', 'C:/code/lib'], call)
    expect(call).toHaveBeenCalledWith('folder_trust_grandfather', { folders: ['C:/code/app', 'C:/code/lib'] })
    expect(kept).toHaveLength(2)
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  it('says "1 folder", not "1 folders"', async () => {
    await grandfatherFolderTrust(['C:/code/app'], async () => ['c:/code/app'])
    expect(vi.mocked(toast.info).mock.calls[0][0]).toMatch(/for 1 folder you/)
    vi.mocked(toast.info).mockClear()
    await grandfatherFolderTrust(['a', 'b'], async () => ['a', 'b'])
    expect(vi.mocked(toast.info).mock.calls[0][0]).toMatch(/for 2 folders you/)
  })

  it('says nothing when nothing was kept, and never throws', async () => {
    expect(await grandfatherFolderTrust(['x'], async () => [])).toEqual([])
    expect(await grandfatherFolderTrust(['x'], async () => { throw new Error('no backend') })).toEqual([])
    expect(await grandfatherFolderTrust(['x'], async () => undefined)).toEqual([])
    expect(toast.info).not.toHaveBeenCalled()
  })
})
