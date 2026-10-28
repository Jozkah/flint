import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentFileInfo } from '@janhq/core'

const toastWarning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))
const fileStatMock = vi.hoisted(() => vi.fn())
vi.mock('@janhq/core', () => ({ fs: { fileStat: fileStatMock } }))

import {
  checkProjectFiles,
  fileFreshness,
  reindexProjectFile,
  resetProjectFileWarnings,
  warnIfProjectFilesChanged,
} from '../projectFileFreshness'

const file = (over: Partial<AttachmentFileInfo> = {}): AttachmentFileInfo => ({
  id: 'f1',
  name: 'notes.md',
  path: '/docs/notes.md',
  type: 'md',
  size: 100,
  chunk_count: 2,
  mtime: 1_700_000_000,
  ...over,
})

describe('fileFreshness', () => {
  it('is fresh when size and mtime match', () => {
    expect(
      fileFreshness(file(), { isDirectory: false, size: 100, modified: 1_700_000_000 })
    ).toBe('fresh')
  })

  it('is changed when the size differs', () => {
    expect(
      fileFreshness(file(), { isDirectory: false, size: 120, modified: 1_700_000_000 })
    ).toBe('changed')
  })

  it('is changed when only the mtime differs', () => {
    expect(
      fileFreshness(file(), { isDirectory: false, size: 100, modified: 1_700_000_500 })
    ).toBe('changed')
  })

  it('is missing when the source is gone', () => {
    expect(fileFreshness(file(), 'missing')).toBe('missing')
  })

  it('shows nothing for a record indexed before mtimes were stored', () => {
    const old = file({ mtime: null })
    expect(fileFreshness(old, 'missing')).toBe('unknown')
    expect(fileFreshness(old, { isDirectory: false, size: 1, modified: 5 })).toBe('unknown')
  })

  it('is unknown when the stat was refused', () => {
    expect(fileFreshness(file(), undefined)).toBe('unknown')
  })
})

describe('checkProjectFiles', () => {
  it('stats only files with a stored mtime and maps each status', async () => {
    const stat = vi.fn(async (p: string) => {
      if (p === '/gone') throw new Error('No such file or directory')
      if (p === '/denied') throw 'fs_read_denied: not allowed'
      return { isDirectory: false, size: 100, modified: 1_700_000_000 }
    })
    const res = await checkProjectFiles(
      [
        file({ id: 'a' }),
        file({ id: 'b', path: '/gone' }),
        file({ id: 'c', path: '/denied' }),
        file({ id: 'd', mtime: undefined }),
      ],
      stat
    )
    expect(res).toEqual({ a: 'fresh', b: 'missing', c: 'unknown', d: 'unknown' })
    expect(stat).toHaveBeenCalledTimes(3)
  })
})

describe('reindexProjectFile', () => {
  it('deletes the old chunks before ingesting, leaving one copy', async () => {
    // A tiny in-memory collection: file id -> chunks.
    const collection = new Map<string, string[]>([['f1', ['old-1', 'old-2']]])
    const order: string[] = []
    await reindexProjectFile('p1', file(), {
      fileStat: async () => ({ isDirectory: false, size: 140, modified: 1_700_000_900 }),
      deleteFile: async (_pid, fid) => {
        order.push('delete')
        collection.delete(fid)
      },
      ingest: async (_pid, input) => {
        order.push('ingest')
        expect(input).toEqual({ path: '/docs/notes.md', name: 'notes.md', type: 'md', size: 140 })
        collection.set('f2', ['new-1', 'new-2', 'new-3'])
      },
    })
    expect(order).toEqual(['delete', 'ingest'])
    expect([...collection.values()].flat()).toEqual(['new-1', 'new-2', 'new-3'])
  })

  it('keeps the indexed copy when the source is gone', async () => {
    const deleteFile = vi.fn()
    await expect(
      reindexProjectFile('p1', file(), {
        fileStat: async () => undefined,
        deleteFile,
        ingest: vi.fn(),
      })
    ).rejects.toThrow(/no longer on disk/)
    expect(deleteFile).not.toHaveBeenCalled()
  })
})

describe('warnIfProjectFilesChanged', () => {
  beforeEach(() => {
    resetProjectFileWarnings()
    toastWarning.mockClear()
    fileStatMock.mockReset()
  })

  it('warns once per project when a file changed', async () => {
    fileStatMock.mockResolvedValue({ isDirectory: false, size: 999, modified: 1 })
    await warnIfProjectFilesChanged('p1', [file()])
    await warnIfProjectFilesChanged('p1', [file()])
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when everything is fresh or predates mtimes', async () => {
    fileStatMock.mockResolvedValue({ isDirectory: false, size: 100, modified: 1_700_000_000 })
    await warnIfProjectFilesChanged('p2', [file(), file({ id: 'old', mtime: null })])
    expect(toastWarning).not.toHaveBeenCalled()
  })
})
