import { describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'

describe('listing worktrees', () => {
  it('reads the server shape ({ worktrees }) as a list instead of crashing callers', async () => {
    const record = { path: 'C:/wt/a', branch: 'jan/cowork/a' }
    invoke.mockResolvedValueOnce({ worktrees: [record] })
    expect(await useCoworkWorktrees.getState().list('C:/p', 'C:/d')).toEqual([record])
    invoke.mockResolvedValueOnce([record])
    expect(await useCoworkWorktrees.getState().list('C:/p', 'C:/d')).toEqual([record])
    invoke.mockResolvedValueOnce(null)
    expect(await useCoworkWorktrees.getState().list('C:/p', 'C:/d')).toEqual([])
  })
})
