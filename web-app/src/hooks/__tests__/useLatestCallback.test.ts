import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLatestCallback } from '../useLatestCallback'

describe('useLatestCallback', () => {
  it('keeps one identity and runs the latest closure', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useLatestCallback((x: number) => x + value),
      { initialProps: { value: 1 } }
    )
    const first = result.current
    expect(first(1)).toBe(2)
    rerender({ value: 10 })
    expect(result.current).toBe(first)
    // A holder of the first identity (a memoized row that did not re-render)
    // still sees the new state.
    expect(first(1)).toBe(11)
  })
})
