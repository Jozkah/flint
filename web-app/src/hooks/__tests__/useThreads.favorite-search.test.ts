import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'

vi.mock('@/services/threads', () => ({
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  updateThread: vi.fn(),
}))
global.__TAURI_INTERNALS__ = { plugins: { path: { sep: '/' } } } as never

import { useThreads } from '../useThreads'

describe('favouriting and search', () => {
  it('a search result reflects the new favourite flag', () => {
    act(() => {
      useThreads.getState().setThreads([
        { id: 't1', title: 'Quokka notes', isFavorite: false, updated: 1 },
      ] as never)
    })
    act(() => useThreads.getState().toggleFavorite('t1'))
    const hit = useThreads
      .getState()
      .getFilteredThreads('Quokka')
      .find((t) => t.id === 't1')
    expect(hit?.isFavorite).toBe(true)
  })
})
