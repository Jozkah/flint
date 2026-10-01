import { describe, it, expect } from 'vitest'
import { splitPath, studioLibraryEntries, studioTitle } from '../library'
import type { GalleryItem } from '../studio'

const item = (kind: 'image' | 'video', path: string, prompt = 'A fox', at = 5) =>
  ({ id: 'x', kind, path, recipe: { prompt, createdAtMs: at } }) as unknown as GalleryItem

describe('Studio results in the Library', () => {
  it('maps kind, file, folder, title and time', () => {
    const [img, vid] = studioLibraryEntries([
      item('image', 'C:\\Users\\a\\studio\\images\\1-a.png'),
      item('video', '/home/a/studio/videos/2-b.webm', '  waves   at night ', 9),
    ])
    expect(img).toMatchObject({ path: '1-a.png', root: 'C:\\Users\\a\\studio\\images', group: 'Image', label: 'PNG', title: 'A fox', updated: 5 })
    expect(vid).toMatchObject({ path: '2-b.webm', root: '/home/a/studio/videos', group: 'Video', label: 'WEBM', title: 'waves at night', updated: 9 })
  })
  it('shortens long prompts and names empty ones', () => {
    expect(studioTitle('x'.repeat(200))).toHaveLength(80)
    expect(studioTitle('  ')).toBe('Untitled')
    expect(splitPath('a.png')).toEqual({ dir: '', name: 'a.png' })
  })
})
