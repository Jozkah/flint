import { describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@/types/attachment'
import { ingestImagesInOrder, sameImage } from '../imageIngest'

const img = (name: string, contentHash?: string): Attachment =>
  ({ type: 'image', name, contentHash, dataUrl: 'data:,' }) as Attachment

/** A draft the update callbacks act on, like the attachments store. */
function draft(initial: Attachment[]) {
  let list = initial
  const snapshots: Attachment[][] = []
  return {
    update: (fn: (prev: Attachment[]) => Attachment[]) => {
      list = fn(list)
      snapshots.push(list)
    },
    get: () => list,
    snapshots,
  }
}

describe('sameImage', () => {
  it('matches by content hash when the image has one, else by name', () => {
    expect(sameImage(img('a.png', 'h1'))(img('b.png', 'h1'))).toBe(true)
    expect(sameImage(img('a.png', 'h1'))(img('a.png', 'h2'))).toBe(false)
    expect(sameImage(img('a.png'))(img('a.png', 'h2'))).toBe(true)
    expect(
      sameImage(img('a.png'))({ type: 'document', name: 'a.png' } as Attachment)
    ).toBe(false)
  })
})

describe('ingestImagesInOrder', () => {
  it('marks each image processing, then stores the backend id', async () => {
    const a = img('a.png', 'ha')
    const d = draft([a])
    await ingestImagesInOrder([a], {
      ingest: async () => ({ id: 'file-1' }),
      update: d.update,
      onFailed: vi.fn(),
    })
    expect(d.snapshots[0][0]).toMatchObject({ processing: true })
    expect(d.get()[0]).toMatchObject({
      processing: false,
      processed: true,
      id: 'file-1',
    })
  })

  it('removes a failed image, reports it, and goes on with the next', async () => {
    const a = img('a.png', 'ha')
    const b = img('b.png', 'hb')
    const d = draft([a, b])
    const onFailed = vi.fn()
    const ingest = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'file-b' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await ingestImagesInOrder([a, b], { ingest, update: d.update, onFailed })
    err.mockRestore()
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(onFailed).toHaveBeenCalledWith(a, expect.any(Error))
    expect(d.get().map((x) => [x.name, x.id])).toEqual([['b.png', 'file-b']])
  })

  it('treats an answer without an id as a failure', async () => {
    const a = img('a.png')
    const d = draft([a])
    const onFailed = vi.fn()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await ingestImagesInOrder([a], {
      ingest: async () => ({}),
      update: d.update,
      onFailed,
    })
    err.mockRestore()
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed.mock.calls[0][1]).toEqual(
      new Error('No ID returned from image ingestion')
    )
    expect(d.get()).toEqual([])
  })
})
