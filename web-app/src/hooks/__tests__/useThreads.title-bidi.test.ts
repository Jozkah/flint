import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'

vi.mock('@/services/threads', () => ({
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  updateThread: vi.fn(),
}))
global.__TAURI_INTERNALS__ = { plugins: { path: { sep: '/' } } } as never

import { useThreads } from '../useThreads'
import { cleanTitle, isBlankTitle } from '@/lib/invisibleText'

describe('thread titles with bidi controls', () => {
  it('cleanTitle removes overrides, isolates, zero-width space and controls', () => {
    expect(cleanTitle('abc\u202Edef')).toBe('abcdef')
    expect(cleanTitle('\u2066x\u2069 \u202Ay\u202C')).toBe('x y')
    expect(cleanTitle('a\u200Bb')).toBe('ab')
    expect(cleanTitle('line\nbreak\u0000')).toBe('line break ')
  })

  it('keeps what real text needs', () => {
    expect(cleanTitle('مرحبا بالعالم')).toBe('مرحبا بالعالم')
    // Persian with a zero-width non-joiner.
    expect(cleanTitle('می\u200Cخواهم')).toBe('می\u200Cخواهم')
    // Family emoji (ZWJ sequence) and a flag.
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    expect(cleanTitle(`Trip ${family} \u{1F1F5}\u{1F1F1}`)).toBe(`Trip ${family} \u{1F1F5}\u{1F1F1}`)
    // Hebrew with a number, held in place by a right-to-left mark.
    expect(cleanTitle('גרסה\u200F 2.0')).toBe('גרסה\u200F 2.0')
    expect(cleanTitle('١\u061C٢')).toBe('١\u061C٢')
    // Text and emoji presentation selectors.
    expect(cleanTitle('❤\uFE0E ❤\uFE0F')).toBe('❤\uFE0E ❤\uFE0F')
  })

  it('treats a title with nothing visible as blank', () => {
    expect(isBlankTitle('\u200B')).toBe(true)
    expect(isBlankTitle('\u202E \u200F\u0007')).toBe(true)
    expect(isBlankTitle('a\u200B')).toBe(false)
  })

  it('a listed or renamed title is stored without them', () => {
    act(() => {
      useThreads.getState().setThreads([
        { id: 't1', title: 'Report\u202Efdp.exe', updated: 1 },
        { id: 't2', title: '\u200B\u202E', updated: 1 },
      ] as never)
    })
    expect(useThreads.getState().threads.t1.title).toBe('Reportfdp.exe')
    // Blank once cleaned: shown as a new thread, as an empty title is.
    expect(useThreads.getState().threads.t2.title).toBe('')
    act(() => useThreads.getState().renameThread('t1', 'New\u202E name'))
    expect(useThreads.getState().threads.t1.title).toBe('New name')
    act(() => useThreads.getState().renameThread('t1', '\u200B'))
    expect(useThreads.getState().threads.t1.title).toBe('New name')
  })

})
