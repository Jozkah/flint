import { describe, it, expect, vi } from 'vitest'

const { fileStat, readdirSync } = vi.hoisted(() => ({
  fileStat: vi.fn(),
  readdirSync: vi.fn(),
}))
vi.mock('@janhq/core', () => ({ fs: { fileStat, readdirSync } }))

import {
  droppedFilePaths,
  getFilesFromPaths,
  maxBytesOf,
  prepareDocumentAttachments,
  splitDuplicates,
} from '../documentIngest'

describe('prepareDocumentAttachments', () => {
  it('keeps supported files, skips unsupported and oversized in order', async () => {
    const onSkip = vi.fn()
    const sizes: Record<string, number> = { '/a/doc.md': 10, '/a/big.pdf': 5000 }
    const out = await prepareDocumentAttachments(
      ['/a/doc.md', '/a/pic.png', '/a/big.pdf', '/a/trailing.'],
      { maxBytes: 1000, statSize: async (p) => sizes[p], onSkip }
    )
    expect(out.attachments.map((a) => a.name)).toEqual(['doc.md'])
    expect(out.attachments[0]).toMatchObject({ path: '/a/doc.md', size: 10 })
    expect(out.unsupported).toEqual(['png', 'unknown'])
    expect(out.tooLarge).toEqual(['big.pdf'])
    expect(onSkip.mock.calls.map((c) => c[0])).toEqual([
      { reason: 'unsupported', extension: 'png' },
      { reason: 'too-large', name: 'big.pdf' },
      { reason: 'unsupported', extension: 'unknown' },
    ])
  })

  it('an unreadable size is unknown, never too large', async () => {
    const out = await prepareDocumentAttachments(['C:\\x\\a.txt'], {
      maxBytes: 1,
      statSize: async () => {
        throw new Error('stat failed')
      },
    })
    expect(out.attachments).toHaveLength(1)
    expect(out.attachments[0].name).toBe('a.txt')
  })

  it('no cap keeps any size', async () => {
    const out = await prepareDocumentAttachments(['/a.md'], {
      maxBytes: undefined,
      statSize: async () => 1e12,
    })
    expect(out.attachments).toHaveLength(1)
  })
})

describe('splitDuplicates', () => {
  it('separates paths already in the project', () => {
    const a = { name: 'a', path: '/a' } as never
    const b = { name: 'b', path: '/b' } as never
    expect(splitDuplicates([a, b], new Set(['/b']))).toEqual({
      fresh: [a],
      duplicates: ['b'],
    })
  })
})

describe('maxBytesOf', () => {
  it('converts a positive MB cap and ignores anything else', () => {
    expect(maxBytesOf(2)).toBe(2 * 1024 * 1024)
    expect(maxBytesOf(0)).toBeUndefined()
    expect(maxBytesOf(undefined)).toBeUndefined()
  })
})

describe('droppedFilePaths', () => {
  const withPath = (path: string) => Object.assign(new File([''], 'x'), { path })
  it('reads paths from items first', () => {
    const transfer = {
      items: [{ kind: 'file', getAsFile: () => withPath('/i') }, { kind: 'string' }],
      files: [withPath('/f')],
    } as unknown as DataTransfer
    expect(droppedFilePaths(transfer)).toEqual(['/i'])
  })
  it('falls back to files when items give none', () => {
    const transfer = { items: [], files: [withPath('/f'), new File([''], 'y')] } as unknown as DataTransfer
    expect(droppedFilePaths(transfer)).toEqual(['/f'])
  })
})

describe('getFilesFromPaths', () => {
  it('keeps files, walks folders for supported files, keeps unstat-able paths', async () => {
    fileStat.mockImplementation(async (p: string) => {
      if (p === '/bad') throw new Error('no')
      return { isDirectory: p === '/dir', size: 1 }
    })
    readdirSync.mockImplementation(async (p: string) =>
      p === '/dir' ? ['/dir/a.md', '/dir/b.png'] : []
    )
    const out = await getFilesFromPaths(['/one.txt', '/dir', '/bad'])
    expect(out).toContain('/one.txt')
    expect(out).toContain('/bad')
    expect(out).toContain('/dir/a.md')
    expect(out).not.toContain('/dir/b.png')
  })
})
