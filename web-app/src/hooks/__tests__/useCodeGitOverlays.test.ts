import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { loadGitBlame, loadGitHeadFile } = vi.hoisted(() => ({
  loadGitBlame: vi.fn(),
  loadGitHeadFile: vi.fn(),
}))

vi.mock('@/lib/coworkGit', () => ({ loadGitBlame, loadGitHeadFile }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { useCodeGitOverlays, __testing } from '../useCodeGitOverlays'

const run = (path: string, savedCount = 0) =>
  renderHook(() =>
    useCodeGitOverlays({
      root: '/r',
      path,
      text: 'a',
      disk: 'a',
      savedCount,
    })
  )

describe('useCodeGitOverlays caches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __testing.headCache.clear()
    __testing.blameCache.clear()
    loadGitHeadFile.mockResolvedValue('a')
    loadGitBlame.mockResolvedValue({ porcelain: '', webUrl: null })
  })

  it('boundedSet keeps at most the limit and evicts the oldest', () => {
    const m = new Map<string, number>()
    for (let i = 0; i < 60; i++) __testing.boundedSet(m, `k${i}`, i)
    expect(m.size).toBeLessThanOrEqual(50)
    expect(m.has('k0')).toBe(false)
    expect(m.has('k59')).toBe(true)
  })

  it('inserting 60 distinct files keeps both caches at 50 or fewer', async () => {
    for (let i = 0; i < 60; i++) {
      const { unmount } = run(`f${i}.ts`)
      await waitFor(() => expect(loadGitBlame).toHaveBeenCalledTimes(i + 1))
      unmount()
    }
    expect(__testing.headCache.size).toBeLessThanOrEqual(50)
    expect(__testing.blameCache.size).toBeLessThanOrEqual(50)
  })

  it('a new savedCount for the same file leaves exactly one blame entry', async () => {
    const first = run('same.ts', 0)
    await waitFor(() => expect(loadGitBlame).toHaveBeenCalledTimes(1))
    first.unmount()
    const second = run('same.ts', 1)
    await waitFor(() => expect(loadGitBlame).toHaveBeenCalledTimes(2))
    second.unmount()
    const keys = [...__testing.blameCache.keys()].filter((k) =>
      k.startsWith('/r\u0000same.ts\u0000')
    )
    expect(keys).toHaveLength(1)
  })

  it('a rejected blame is not cached', async () => {
    loadGitBlame.mockRejectedValueOnce(new Error('git busy'))
    const { unmount } = run('bad.ts')
    await waitFor(() => expect(loadGitBlame).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(__testing.blameCache.size).toBe(0))
    unmount()
  })
})
