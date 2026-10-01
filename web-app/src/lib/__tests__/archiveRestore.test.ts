import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  restore: vi.fn(),
  put: vi.fn(async () => 'x'),
  addAssistant: vi.fn(),
  assistants: [] as { id: string }[],
  refreshGallery: vi.fn(async () => {}),
}))

vi.mock('@/lib/archive', () => ({
  archiveApi: { restore: h.restore, put: h.put, list: async () => [] },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: { getState: () => ({ assistants: h.assistants, addAssistant: h.addAssistant }) },
}))
vi.mock('@/hooks/useStudio', () => ({
  useStudio: { getState: () => ({ refreshGallery: h.refreshGallery }) },
}))
vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))
vi.mock('@/hooks/useThreads', () => ({ useThreads: { getState: () => ({}) } }))
vi.mock('@/hooks/useThreadManagement', () => ({ useThreadManagementStore: { getState: () => ({}) } }))
vi.mock('@/lib/rooms/store', () => ({ useRoomsStore: { getState: () => ({}) } }))
vi.mock('@/lib/groups/store', () => ({ useConversationGroups: { getState: () => ({}) } }))
vi.mock('@/lib/coworkSessionLifecycle', () => ({ restoreCoworkSession: () => true }))

import { restoreArchived } from '../archiveRestore'

const item = (kind: string, id: string) =>
  ({ archiveId: id, kind, id, title: `T ${id}`, archivedAt: 1, origin: '', storage: 'payload', sizeBytes: 1 }) as never

describe('restoring the newer kinds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.assistants = []
  })

  it('puts an assistant back in the store', async () => {
    h.restore.mockResolvedValue({ kind: 'assistant', id: 'a1', title: 'A', payload: { id: 'a1', name: 'A' } })
    await restoreArchived(item('assistant', 'a1'))
    expect(h.addAssistant).toHaveBeenCalledWith({ id: 'a1', name: 'A' })
  })

  it('re-archives an assistant whose id is live again instead of losing it', async () => {
    h.assistants = [{ id: 'a1' }]
    h.restore.mockResolvedValue({ kind: 'assistant', id: 'a1', title: 'A', payload: { id: 'a1' } })
    await expect(restoreArchived(item('assistant', 'a1'))).rejects.toThrow('already exists')
    expect(h.put).toHaveBeenCalledWith('assistant', 'a1', 'T a1', { id: 'a1' }, undefined)
    expect(h.addAssistant).not.toHaveBeenCalled()
  })

  it('reloads both galleries after a Studio result returns', async () => {
    h.restore.mockResolvedValue({ kind: 'studio', id: 's1', title: 'cat' })
    await restoreArchived(item('studio', 'images-s1'))
    expect(h.refreshGallery).toHaveBeenCalledWith('image')
    expect(h.refreshGallery).toHaveBeenCalledWith('video')
  })
})
