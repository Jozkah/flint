import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const getModelProps = vi.fn()
vi.mock('@/lib/llamacppRouterProps', () => ({
  getLocalPropsExtension: (p?: string) =>
    p === 'llamacpp' ? { getModelProps } : undefined,
}))

import { contextColumn, useLoadedContextWindows } from '../useLoadedContextWindows'

const t = (k: string) => k.split('.').pop()!

describe('contextColumn', () => {
  it('shows the engine window and marks it auto-fit when no size is saved', () => {
    expect(contextColumn(131072, undefined, t)).toMatchObject({
      value: (131072).toLocaleString(),
      note: 'contextAutoFit',
    })
  })
  it('shows the live window without a note when a size is saved', () => {
    expect(contextColumn(8192, 8192, t)).toEqual({ value: (8192).toLocaleString() })
  })
  it('falls back to the saved size, then auto, when not loaded', () => {
    expect(contextColumn(undefined, 4096, t).value).toBe((4096).toLocaleString())
    expect(contextColumn(undefined, undefined, t).value).toBe('contextAuto')
  })
})

describe('useLoadedContextWindows', () => {
  beforeEach(() => getModelProps.mockReset())
  it('reads n_ctx for each loaded model only', async () => {
    getModelProps.mockImplementation(async (id: string) =>
      id === 'gemma' ? { nCtx: 131072 } : undefined
    )
    const { result } = renderHook(() =>
      useLoadedContextWindows('llamacpp', ['gemma', 'other'])
    )
    await waitFor(() => expect(result.current).toEqual({ gemma: 131072 }))
    expect(getModelProps).toHaveBeenCalledTimes(2)
  })
  it('asks nothing for a remote provider or when nothing is loaded', () => {
    renderHook(() => useLoadedContextWindows('openai', ['x']))
    renderHook(() => useLoadedContextWindows('llamacpp', []))
    expect(getModelProps).not.toHaveBeenCalled()
  })
})
