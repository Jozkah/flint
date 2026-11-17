import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

const media = vi.fn(
  async (_k: string, id: string) => `data:image/png;base64,${id}`
)
vi.mock('@/lib/studio/studio', () => ({
  studioApi: { media: (k: string, id: string) => media(k, id) },
}))

import { addChatImages, markGalleryImageDeleted } from '@/lib/chatImages'
import {
  loadMadePictures,
  savedPictureNames,
  withRestoredPictures,
} from '../restoreMadePictures'
import { madePictures } from '@/containers/message/madePictures'
import { outputForStorage, toolOutputWithImages } from '../toolOutputImages'

beforeEach(() => {
  window.localStorage.clear()
  media.mockClear()
})

describe('restoring made pictures after a save', () => {
  const live = toolOutputWithImages(
    JSON.stringify({ status: 'done', images: ['img_1', 'img_2'] }),
    [{ dataUrl: 'data:image/png;base64,AAA', name: 'img_1.png' }]
  )
  const saved = outputForStorage(live)

  it('reads the names back from the saved result', () => {
    expect(savedPictureNames(saved)).toEqual(['img_1', 'img_2'])
    expect(savedPictureNames('no pictures here')).toEqual([])
    expect(savedPictureNames([{ type: 'text' }])).toEqual([])
  })

  it('loads them from the gallery and skips a deleted one', async () => {
    addChatImages('s1', [
      { galleryId: 'g1', prompt: 'a' },
      { galleryId: 'g2', prompt: 'b' },
    ])
    markGalleryImageDeleted('g2')
    const got = await loadMadePictures('s1', ['img_1', 'img_2', 'img_9'])
    expect(got.map((i) => i.name)).toEqual(['img_1.png'])
    expect(got[0].dataUrl).toContain('g1')
  })

  it('puts the pictures on the part so the message shows them', () => {
    const message = {
      id: 'm',
      role: 'assistant',
      parts: [
        {
          type: 'tool-image_gen',
          toolCallId: 'c1',
          state: 'output-available',
          output: saved,
        },
      ],
    } as unknown as UIMessage
    const out = withRestoredPictures(
      [message],
      new Map([
        ['c1', [{ dataUrl: 'data:image/png;base64,Z', name: 'img_1.png' }]],
      ])
    )
    expect(madePictures(out[0].parts as never)).toHaveLength(1)
    expect(withRestoredPictures([message], new Map())[0]).toBe(message)
  })
})
