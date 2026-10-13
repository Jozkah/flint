import { describe, it, expect, vi, beforeEach } from 'vitest'

const status = vi.fn()
const generateImage = vi.fn()
const media = vi.fn()

vi.mock('@/lib/studio/studio', () => ({
  studioApi: {
    status: () => status(),
    generateImage: (p: unknown) => generateImage(p),
    media: (k: string, id: string) => media(k, id),
  },
}))

import { isImageTool, runImageTool } from '../chatImageTools'
import {
  addChatImages,
  chatsUsingGalleryImage,
  clearChatImages,
  findChatImage,
  listChatImages,
  markGalleryImageDeleted,
} from '../chatImages'

const loaded = {
  supported: true,
  resident: { model_id: 'z-image-turbo', kind: 'image', busy: false },
}

let n = 0
const thread = () => `t-${++n}`

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  status.mockResolvedValue(loaded)
  media.mockImplementation(async (_k: string, id: string) => `data:image/png;base64,${id}`)
})

describe('chat image names', () => {
  it('numbers pictures per thread, continuing after the highest', () => {
    const t = thread()
    expect(addChatImages(t, [{ galleryId: 'a', prompt: 'p' }]).map((i) => i.id)).toEqual(['img_1'])
    expect(
      addChatImages(t, [
        { galleryId: 'b', prompt: 'p' },
        { galleryId: 'c', prompt: 'p' },
      ]).map((i) => i.id)
    ).toEqual(['img_2', 'img_3'])
    expect(addChatImages(thread(), [{ galleryId: 'x', prompt: 'p' }])[0].id).toBe('img_1')
  })

  it('finds a picture by name, ignoring case and spaces', () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'a', prompt: 'p' }])
    expect(findChatImage(t, ' IMG_1 ')?.galleryId).toBe('a')
    expect(findChatImage(t, 'img_2')).toBeUndefined()
  })

  it('survives a reload through localStorage and forgets on clear', () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'a', prompt: 'p' }])
    // A fresh read: same thread id, only storage to go on.
    expect(JSON.parse(window.localStorage.getItem(`flint:chat-images:${t}`) ?? '[]')).toHaveLength(1)
    clearChatImages(t)
    expect(listChatImages(t)).toEqual([])
  })
})

describe('a picture deleted from the gallery', () => {
  it('is found only in the chats that used it, and keeps its name', () => {
    const a = thread()
    const b = thread()
    addChatImages(a, [{ galleryId: 'shared', prompt: 'p' }])
    addChatImages(b, [{ galleryId: 'other', prompt: 'p' }])
    expect(chatsUsingGalleryImage('shared')).toEqual([a])
    markGalleryImageDeleted('shared')
    expect(findChatImage(a, 'img_1')?.deleted).toBe(true)
    expect(findChatImage(b, 'img_1')?.deleted).toBeUndefined()
    // The name is not handed to the next picture.
    expect(addChatImages(a, [{ galleryId: 'new', prompt: 'p' }])[0].id).toBe('img_2')
    expect(chatsUsingGalleryImage('shared')).toEqual([])
  })

  it('is refused by view and edit with a clear reason', async () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'g1', prompt: 'a' }])
    markGalleryImageDeleted('g1')
    for (const [tool, input] of [
      ['image_view', { image: 'img_1' }],
      ['image_edit', { prompt: 'x', image: 'img_1' }],
      ['image_edit', { prompt: 'x', references: ['img_1'] }],
    ] as const) {
      expect(await runImageTool(tool, input, t)).toMatchObject({
        error: expect.stringContaining('was deleted from the Studio gallery'),
      })
    }
    expect(generateImage).not.toHaveBeenCalled()
  })
})

describe('picture tools', () => {
  it('are named image_gen, image_edit and image_view only', () => {
    for (const name of ['image_gen', 'image_edit', 'image_view']) {
      expect(isImageTool(name)).toBe(true)
    }
    expect(isImageTool('generate_image')).toBe(false) // the old name is gone
  })

  it('image_gen makes pictures, names them and returns them', async () => {
    const t = thread()
    generateImage.mockResolvedValue({ ids: ['g1', 'g2'], seed: 5 })
    const r = await runImageTool('image_gen', { prompt: 'a cat', count: 2 }, t)
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'z-image-turbo', prompt: 'a cat', count: 2 })
    )
    expect(JSON.parse(r.content ?? '{}').images).toEqual(['img_1', 'img_2'])
    expect(r.images?.map((i) => i.name)).toEqual(['img_1.png', 'img_2.png'])
  })

  it('refuses without a prompt, an unloaded model, or a bad count', async () => {
    const t = thread()
    expect(await runImageTool('image_gen', {}, t)).toEqual({ error: 'image_gen needs a prompt.' })
    expect(await runImageTool('image_gen', { prompt: 'x', count: 9 }, t)).toMatchObject({
      error: expect.stringContaining('count'),
    })
    status.mockResolvedValue({ supported: true, resident: null })
    expect(await runImageTool('image_gen', { prompt: 'x' }, t)).toMatchObject({
      error: expect.stringContaining('No image model is loaded'),
    })
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('image_edit starts from a named picture with a strength', async () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'g-src', prompt: 'a cat' }])
    generateImage.mockResolvedValue({ ids: ['g-new'], seed: 1 })
    const r = await runImageTool('image_edit', { prompt: 'make it blue', image: 'img_1', strength: 0.4 }, t)
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ init_image_id: 'g-src', strength: 0.4, reference_ids: [] })
    )
    expect(JSON.parse(r.content ?? '{}').images).toEqual(['img_2'])
    // The original is kept under its own name.
    expect(findChatImage(t, 'img_1')?.galleryId).toBe('g-src')
  })

  it('image_edit sends references without a strength', async () => {
    const t = thread()
    addChatImages(t, [
      { galleryId: 'g1', prompt: 'a' },
      { galleryId: 'g2', prompt: 'b' },
    ])
    generateImage.mockResolvedValue({ ids: ['g3'], seed: 1 })
    await runImageTool('image_edit', { prompt: 'combine', references: ['img_1', 'img_2'] }, t)
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        init_image_id: undefined,
        strength: undefined,
        reference_ids: ['g1', 'g2'],
      })
    )
  })

  it('image_edit names the pictures it does have when one is unknown', async () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'g1', prompt: 'a' }])
    const r = await runImageTool('image_edit', { prompt: 'x', image: 'img_7' }, t)
    expect(r).toMatchObject({ error: expect.stringContaining('Pictures so far: img_1') })
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('image_edit needs a picture and a sane strength', async () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'g1', prompt: 'a' }])
    expect(await runImageTool('image_edit', { prompt: 'x' }, t)).toMatchObject({
      error: expect.stringContaining('needs `image` or `references`'),
    })
    expect(await runImageTool('image_edit', { prompt: 'x', image: 'img_1', strength: 2 }, t)).toMatchObject({
      error: expect.stringContaining('strength'),
    })
  })

  it('image_view returns the picture, and says so when it is gone', async () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'g1', prompt: 'a cat' }])
    const r = await runImageTool('image_view', { image: 'img_1' }, t)
    expect(r.images?.[0].dataUrl).toBe('data:image/png;base64,g1')
    media.mockRejectedValue(new Error('missing'))
    expect(await runImageTool('image_view', { image: 'img_1' }, t)).toMatchObject({
      error: expect.stringContaining('was deleted from the Studio gallery'),
    })
  })
})
