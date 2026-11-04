import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const getFiles = vi.fn()
vi.mock('@/lib/huggingface', () => ({
  getHuggingFaceFiles: (...args: unknown[]) => getFiles(...args),
}))

import { useRepoFiles } from '../useRepoFiles'

const file = (name: string) => ({ name, size: 1 })

describe('useRepoFiles', () => {
  beforeEach(() => getFiles.mockReset())

  it('fetches a repo once while a fetch is in flight', async () => {
    let resolve!: (v: unknown) => void
    getFiles.mockReturnValue(new Promise((r) => (resolve = r)))
    const { result } = renderHook(() => useRepoFiles('t'))
    let first!: Promise<unknown>
    let second: unknown
    await act(async () => {
      first = result.current.loadFiles('a/b')
      second = await result.current.loadFiles('a/b')
    })
    expect(second).toEqual([])
    expect(getFiles).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve([file('m.gguf')])
      await first
    })
    expect(result.current.filesByRepo['a/b']).toEqual([file('m.gguf')])
    expect(result.current.loadingFiles['a/b']).toBe(false)
  })

  it('keeps a per-repo error and clears it on a successful retry', async () => {
    getFiles.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useRepoFiles('t'))
    await act(async () => {
      await result.current.loadFiles('a/b')
    })
    expect(result.current.fileErrors['a/b']).toBe('boom')
    getFiles.mockResolvedValueOnce([file('x.gguf')])
    await act(async () => {
      await result.current.loadFiles('a/b')
    })
    expect(result.current.fileErrors['a/b']).toBeUndefined()
    expect(result.current.filesByRepo['a/b']).toEqual([file('x.gguf')])
  })

  it('drops cached files when the token changes', async () => {
    getFiles.mockResolvedValue([file('x.gguf')])
    const { result, rerender } = renderHook(({ t }) => useRepoFiles(t), {
      initialProps: { t: 'one' as string | undefined },
    })
    await act(async () => {
      await result.current.loadFiles('a/b')
    })
    expect(result.current.filesByRepo['a/b']).toBeDefined()
    rerender({ t: 'two' })
    expect(result.current.filesByRepo['a/b']).toBeUndefined()
    await act(async () => {
      await result.current.loadFiles('a/b')
    })
    expect(getFiles).toHaveBeenCalledTimes(2)
  })
})
