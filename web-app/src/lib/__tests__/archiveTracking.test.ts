import { describe, it, expect, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  archiveApi,
  settleArchiveWork,
  trackArchiveWork,
  useArchiveRevision,
} from '../archive'

describe('archive background work', () => {
  it('lists only after a tracked in-flight archive finished', async () => {
    let finish: () => void = () => {}
    const order: string[] = []
    invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd)
      return []
    })
    const before = useArchiveRevision.getState().revision
    trackArchiveWork(
      new Promise<void>((r) => {
        finish = () => {
          order.push('archived')
          r()
        }
      })
    )
    const listing = archiveApi.list()
    await Promise.resolve()
    expect(order).toEqual([])
    finish()
    await listing
    expect(order).toEqual(['archived', 'archive_list'])
    expect(useArchiveRevision.getState().revision).toBeGreaterThan(before)
  })

  it('still settles and bumps when the work fails', async () => {
    const before = useArchiveRevision.getState().revision
    await expect(trackArchiveWork(Promise.reject(new Error('x')))).rejects.toThrow('x')
    await settleArchiveWork()
    expect(useArchiveRevision.getState().revision).toBeGreaterThan(before)
  })
})
