import type { GalleryItem } from '@/lib/studio/studio'

/** A Studio result as the Library lists it, next to Cowork's artifacts. */
export type StudioLibraryEntry = {
  /** The file name inside `root` (the gallery folder). */
  path: string
  root: string
  title: string
  group: 'Image' | 'Video'
  label: 'PNG' | 'WEBM'
  updated: number
  item: GalleryItem
}

const TITLE_MAX = 80

/** Splits an absolute path into its folder and file name, either separator. */
export function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i) || p.slice(0, 1), name: p.slice(i + 1) }
}

export function studioTitle(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim() || 'Untitled'
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

export function studioLibraryEntries(items: readonly GalleryItem[]): StudioLibraryEntry[] {
  return items.map((item) => {
    const { dir, name } = splitPath(item.path)
    const video = item.kind === 'video'
    return {
      path: name,
      root: dir,
      title: studioTitle(item.recipe.prompt),
      group: video ? 'Video' : 'Image',
      label: video ? 'WEBM' : 'PNG',
      updated: item.recipe.createdAtMs,
      item,
    }
  })
}
