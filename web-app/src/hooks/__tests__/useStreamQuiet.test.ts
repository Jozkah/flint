import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { useStreamQuiet, QUIET_STREAM_MS } from '../useStreamQuiet'

const msg = (parts: unknown[]): UIMessage[] =>
  [{ id: 'a', role: 'assistant', parts }] as unknown as UIMessage[]

describe('useStreamQuiet', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('is null while tokens keep arriving', () => {
    const { result, rerender } = renderHook(
      ({ m }) => useStreamQuiet('streaming', m),
      { initialProps: { m: msg([{ type: 'text', text: 'a' }]) } }
    )
    act(() => void vi.advanceTimersByTime(QUIET_STREAM_MS - 1000))
    rerender({ m: msg([{ type: 'text', text: 'ab' }]) })
    act(() => void vi.advanceTimersByTime(QUIET_STREAM_MS - 1000))
    expect(result.current).toBeNull()
  })

  it('reports when the last token landed once the stream goes quiet', () => {
    const start = Date.now()
    const m = msg([{ type: 'text', text: 'a' }])
    const { result } = renderHook(() => useStreamQuiet('streaming', m))
    act(() => void vi.advanceTimersByTime(QUIET_STREAM_MS + 1000))
    expect(result.current).toBe(start)
  })

  it('stays null when not streaming', () => {
    const m = msg([{ type: 'text', text: 'a' }])
    const { result } = renderHook(() => useStreamQuiet('submitted', m))
    act(() => void vi.advanceTimersByTime(QUIET_STREAM_MS * 3))
    expect(result.current).toBeNull()
  })

  it('does not count a running tool as the model going quiet', () => {
    const m = msg([{ type: 'tool-bash', state: 'input-available' }])
    const { result } = renderHook(() => useStreamQuiet('streaming', m))
    act(() => void vi.advanceTimersByTime(QUIET_STREAM_MS * 3))
    expect(result.current).toBeNull()
  })
})
