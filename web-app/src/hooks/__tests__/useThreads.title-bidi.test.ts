import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'

vi.mock('@/services/threads', () => ({
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  updateThread: vi.fn(),
}))
global.__TAURI_INTERNALS__ = { plugins: { path: { sep: '/' } } } as never

import { useThreads } from '../useThreads'
import { cleanTitle } from '@/lib/invisibleText'

describe('thread titles with bidi controls', () => {
  it('cleanTitle removes overrides, isolates and controls but keeps RTL text', () => {
    expect(cleanTitle('abc‮def')).toBe('abcdef')
    expect(cleanTitle('⁦x⁩ ‪y‬')).toBe('x y')
    expect(cleanTitle('a​b')).toBe('ab')
    expect(cleanTitle('line\nbreak\u0000')).toBe('line break ')
    expect(cleanTitle('مرحبا بالعالم')).toBe('مرحبا بالعالم')
    expect(cleanTitle('שלום')).toBe('שלום')
  })

  it('a listed or renamed title is stored without them', () => {
    act(() => {
      useThreads.getState().setThreads([
        { id: 't1', title: 'Report‮fdp.exe', updated: 1 },
      ] as never)
    })
    expect(useThreads.getState().threads.t1.title).toBe('Reportfdp.exe')
    act(() => useThreads.getState().renameThread('t1', 'New‮ name'))
    expect(useThreads.getState().threads.t1.title).toBe('New name')
  })
})
