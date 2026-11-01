import { describe, it, expect, vi, beforeEach } from 'vitest'

const { listAttachments } = vi.hoisted(() => ({ listAttachments: vi.fn() }))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => ({ listAttachments }) }) },
}))

import { useAttachmentNamesStore } from '../useAttachmentNames'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('useAttachmentNames (HKS-019)', () => {
  beforeEach(() => {
    listAttachments.mockReset()
    useAttachmentNamesStore.setState({ byId: {}, loading: {}, loadedScopes: {}, missed: {} })
  })

  it('refetches a loaded scope once for a file attached after the first load', async () => {
    listAttachments.mockResolvedValueOnce([{ id: 'a', name: 'a.pdf' }])
    useAttachmentNamesStore.getState().ensure('thread', 't1', ['a'])
    await flush()
    // Known name: no refetch.
    useAttachmentNamesStore.getState().ensure('thread', 't1', ['a'])
    expect(listAttachments).toHaveBeenCalledTimes(1)

    listAttachments.mockResolvedValueOnce([
      { id: 'a', name: 'a.pdf' },
      { id: 'b', name: 'b.txt' },
    ])
    useAttachmentNamesStore.getState().ensure('thread', 't1', ['a', 'b'])
    await flush()
    expect(listAttachments).toHaveBeenCalledTimes(2)
    expect(useAttachmentNamesStore.getState().byId.b).toBe('b.txt')
  })

  it('does not refetch for ever for an id the scope does not have', async () => {
    listAttachments.mockResolvedValue([])
    useAttachmentNamesStore.getState().ensure('thread', 't1', ['gone'])
    await flush()
    useAttachmentNamesStore.getState().ensure('thread', 't1', ['gone'])
    await flush()
    expect(listAttachments).toHaveBeenCalledTimes(1)
  })
})
