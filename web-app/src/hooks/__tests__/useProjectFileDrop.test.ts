import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const { fileStat } = vi.hoisted(() => ({ fileStat: vi.fn() }))
vi.mock('@janhq/core', () => ({ fs: { fileStat } }))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
const { namedFilePaths } = vi.hoisted(() => ({ namedFilePaths: vi.fn() }))
vi.mock('@/lib/fileDrop', () => ({ namedFilePaths }))

import { toast } from 'sonner'
import { useProjectFileDrop } from '../useProjectFileDrop'

const t = (k: string) => k
const event = (dataTransfer: unknown) =>
  ({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer,
  }) as unknown as React.DragEvent

const withPath = (path: string) => Object.assign(new File([''], 'x'), { path })

beforeEach(() => vi.clearAllMocks())

describe('useProjectFileDrop', () => {
  it('highlights on drag over and clears on leave', () => {
    const { result } = renderHook(() =>
      useProjectFileDrop({ enabled: true, onPaths: vi.fn(), t })
    )
    act(() => result.current.handleDragOver(event(null)))
    expect(result.current.isDragging).toBe(true)
    act(() => result.current.handleDragLeave(event(null)))
    expect(result.current.isDragging).toBe(false)
  })

  it('hints instead of ingesting when attachments are off', async () => {
    const onPaths = vi.fn()
    const { result } = renderHook(() =>
      useProjectFileDrop({ enabled: false, onPaths, t })
    )
    await act(() => result.current.handleDrop(event({ items: [], files: [withPath('/a')] })))
    expect(onPaths).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith('common:toast.attachmentsDisabledInfo.title')
  })

  it('ingests the paths the dropped files carry', async () => {
    const onPaths = vi.fn(async () => {})
    const { result } = renderHook(() => useProjectFileDrop({ enabled: true, onPaths, t }))
    await act(() => result.current.handleDrop(event({ items: [], files: [withPath('/a.md')] })))
    expect(onPaths).toHaveBeenCalledWith(['/a.md'])
  })

  it('takes a trusted named file, asks about a folder or an untrusted name', async () => {
    namedFilePaths.mockReturnValue({ paths: ['/f.md', '/dir'], trusted: true })
    fileStat.mockImplementation(async (p: string) => ({ isDirectory: p === '/dir' }))
    const onPaths = vi.fn(async () => {})
    const { result } = renderHook(() => useProjectFileDrop({ enabled: true, onPaths, t }))
    await act(() => result.current.handleDrop(event({ items: [], files: [] })))
    expect(onPaths).toHaveBeenCalledWith(['/f.md'])
    expect(toast.info).toHaveBeenCalledWith(
      'common:pastedPath.folder',
      expect.objectContaining({ action: expect.anything() })
    )

    vi.clearAllMocks()
    namedFilePaths.mockReturnValue({ paths: ['/f.md'], trusted: false })
    await act(() => result.current.handleDrop(event({ items: [], files: [] })))
    expect(onPaths).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith('common:pastedPath.file', expect.anything())
  })
})
