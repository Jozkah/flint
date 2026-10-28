import { describe, it, expect, afterEach } from 'vitest'
import {
  addChatImages,
  listChatImages,
  markGalleryImageDeleted,
} from '../chatImages'

const KEY = 'flint:chat-images:'

afterEach(() => {
  window.localStorage.clear()
})

describe('chatImages across windows', () => {
  it('names a new picture after one another window saved since this one cached', () => {
    // Window A loads and caches an empty list.
    expect(listChatImages('t-a')).toEqual([])
    // Window B names img_1 straight into storage.
    window.localStorage.setItem(
      KEY + 't-a',
      JSON.stringify([{ id: 'img_1', galleryId: 'g-b', prompt: 'from b' }])
    )
    const added = addChatImages('t-a', [{ galleryId: 'g-a', prompt: 'from a' }])
    expect(added.map((i) => i.id)).toEqual(['img_2'])
    const stored = JSON.parse(window.localStorage.getItem(KEY + 't-a') ?? '[]')
    expect(stored.map((i: { id: string }) => i.id)).toEqual(['img_1', 'img_2'])
  })

  it('drops its cached list when another window changes storage', () => {
    expect(listChatImages('t-b')).toEqual([])
    addChatImages('t-b', [{ galleryId: 'g1', prompt: 'p' }])
    window.localStorage.setItem(KEY + 't-b', JSON.stringify([]))
    window.dispatchEvent(new StorageEvent('storage', { key: KEY + 't-b' }))
    expect(listChatImages('t-b')).toEqual([])
  })

  it('keeps this session’s names when storage holds nothing', () => {
    addChatImages('t-c', [{ galleryId: 'g1', prompt: 'p' }])
    window.localStorage.removeItem(KEY + 't-c')
    const added = addChatImages('t-c', [{ galleryId: 'g2', prompt: 'q' }])
    expect(added.map((i) => i.id)).toEqual(['img_2'])
  })

  it('marks a deleted picture on the stored list, not a stale copy', () => {
    expect(listChatImages('t-d')).toEqual([])
    window.localStorage.setItem(
      KEY + 't-d',
      JSON.stringify([{ id: 'img_1', galleryId: 'g-x', prompt: 'p' }])
    )
    markGalleryImageDeleted('g-x')
    const stored = JSON.parse(window.localStorage.getItem(KEY + 't-d') ?? '[]')
    expect(stored[0].deleted).toBe(true)
  })
})
