import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  blameForEdited,
  computeHunks,
  parseBlamePorcelain,
  relativeTime,
  type Blame,
  type BlameCommit,
  type ChangeHunk,
} from '@/lib/codeGutter'
import { loadGitBlame, loadGitHeadFile } from '@/lib/coworkGit'

/** The Code panel's git overlays, on or off; remembered per user. */
type OverlaySettings = {
  changeMarkers: boolean
  inlineBlame: boolean
  set: (patch: Partial<Pick<OverlaySettings, 'changeMarkers' | 'inlineBlame'>>) => void
}

export const useCodeOverlaySettings = create<OverlaySettings>()(
  persist(
    (set) => ({
      changeMarkers: true,
      inlineBlame: true,
      set: (patch) => set(patch),
    }),
    {
      name: 'flint.codePanel.overlays',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        changeMarkers: s.changeMarkers,
        inlineBlame: s.inlineBlame,
      }),
    }
  )
)

// Cached per file and what HEAD holds for it, so reopening a tab is instant
// and a new commit (which changes the HEAD bytes) is fetched afresh.
const headCache = new Map<string, Promise<string | null>>()
const blameCache = new Map<
  string,
  Promise<{ blame: Blame | null; webUrl: string | null }>
>()

/**
 * Change hunks and blame for the file in the editor.
 *
 * `root` is the git working tree the file is read from and `path` is relative
 * to it. `original`, when given, is the base instead of HEAD: a Review only
 * sandbox copy is compared with the project file it copies. `disk` is what
 * the file holds on disk now (for mapping blame through unsaved edits), and
 * `savedCount` moves when a save lands, so blame is read again.
 */
export function useCodeGitOverlays(input: {
  root: string | null
  path: string | null
  text: string | null
  disk: string | null
  original?: string | null
  savedCount: number
}) {
  const { changeMarkers, inlineBlame } = useCodeOverlaySettings()
  const { root, path, text, disk, original, savedCount } = input
  const [head, setHead] = useState<string | null>(null)
  const [blame, setBlame] = useState<{
    blame: Blame | null
    webUrl: string | null
  } | null>(null)

  useEffect(() => {
    setHead(null)
    if (!changeMarkers || !root || !path || original !== undefined) return
    let alive = true
    const key = `${root}\u0000${path}`
    let hit = headCache.get(key)
    if (!hit) {
      hit = loadGitHeadFile(root, path).catch(() => null)
      headCache.set(key, hit)
    }
    void hit.then((value) => alive && setHead(value))
    return () => {
      alive = false
    }
  }, [changeMarkers, root, path, original])

  useEffect(() => {
    setBlame(null)
    if (!inlineBlame || !root || !path) return
    let alive = true
    const key = `${root}\u0000${path}\u0000${head?.length ?? -1}\u0000${savedCount}`
    let hit = blameCache.get(key)
    if (!hit) {
      hit = loadGitBlame(root, path)
        .then((r) => ({
          blame: r.porcelain ? parseBlamePorcelain(r.porcelain) : null,
          webUrl: r.webUrl,
        }))
        .catch(() => ({ blame: null, webUrl: null }))
      blameCache.set(key, hit)
    }
    void hit.then((value) => alive && setBlame(value))
    return () => {
      alive = false
    }
  }, [inlineBlame, root, path, head, savedCount])

  const base = original !== undefined ? original : head
  const hunks = useMemo<ChangeHunk[]>(
    () =>
      changeMarkers && base !== null && base !== undefined && text !== null
        ? computeHunks(base, text)
        : [],
    [changeMarkers, base, text]
  )
  const blameLines = useMemo(
    () =>
      inlineBlame && blame?.blame && text !== null && disk !== null
        ? blameForEdited(blame.blame, disk, text)
        : null,
    [inlineBlame, blame, text, disk]
  )
  return { hunks, blameLines, webUrl: blame?.webUrl ?? null }
}

/** "Ada, 2 weeks ago • Fix the parser", or the uncommitted wording. */
export function useBlameLabel() {
  const { t } = useTranslation()
  return useMemo(() => {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    return (commit: BlameCommit) => {
      if (commit.uncommitted) return t('common:codePanel.notCommitted')
      const { value, unit } = relativeTime(commit.time)
      return `${commit.author}, ${rtf.format(value, unit)} • ${commit.summary}`
    }
  }, [t])
}

/** Hover state for the blame card, with a grace period to reach the card. */
export function useBlameHover() {
  const [hover, setHover] = useState<{
    commit: BlameCommit
    anchor: DOMRect
  } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const leave = () => {
    cancel()
    timer.current = setTimeout(() => setHover(null), 250)
  }
  const onBlameHover = (commit: BlameCommit, el: HTMLElement | null) => {
    if (!el) return leave()
    cancel()
    setHover({ commit, anchor: el.getBoundingClientRect() })
  }
  useEffect(() => cancel, [])
  return { hover, onBlameHover, keep: cancel, leave }
}
