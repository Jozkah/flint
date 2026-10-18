import { createContext } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * The tallest a transcript answer is drawn (at most 80% of the visible
 * conversation, so its header and the next row stay in reach) before it scrolls inside itself, so
 * a 5,000-word answer never makes the page endless: the page scrolls over the
 * questions, an answer scrolls over its own length.
 */
export const ANSWER_MAX_HEIGHT = 'max(12rem, min(60vh, calc(var(--room-transcript-h, 100vh) * 0.8)))'

type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number }

/** How far a box can scroll; 0 when its content fits. */
export function scrollRange(box: Pick<ScrollBox, 'scrollHeight' | 'clientHeight'>): number {
  return Math.max(0, box.scrollHeight - box.clientHeight)
}

/**
 * Where `target` should scroll to sit at the same point of its answer as
 * `source` does of its own: the same fraction of the scrollable range, so two
 * answers of very different lengths stay aligned top to bottom. Null when
 * either one does not overflow (that column just stays still).
 */
export function linkedScrollTop(
  source: ScrollBox,
  target: Pick<ScrollBox, 'scrollHeight' | 'clientHeight'>
): number | null {
  const from = scrollRange(source)
  const to = scrollRange(target)
  if (from <= 0 || to <= 0) return null
  const ratio = Math.min(1, Math.max(0, source.scrollTop / from))
  return Math.round(ratio * to)
}

/** Whether a box is scrolled to (or within a few px of) its bottom. */
export function atScrollBottom(box: ScrollBox, slack = 8): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack
}

type RoomsViewPrefs = {
  /** Compare columns of one question scroll together. On by default. */
  linkScroll: boolean
  /** Answers the user opened to their full height, by message id. */
  expanded: Record<string, true>
  setLinkScroll: (on: boolean) => void
  toggleExpanded: (messageId: string) => void
}

export const useRoomsViewPrefs = create<RoomsViewPrefs>()(
  persist(
    (set) => ({
      linkScroll: true,
      expanded: {},
      setLinkScroll: (linkScroll) => set({ linkScroll }),
      toggleExpanded: (id) =>
        set((s) => {
          const expanded = { ...s.expanded }
          if (expanded[id]) delete expanded[id]
          else expanded[id] = true
          return { expanded }
        }),
    }),
    {
      name: 'flint-rooms-view',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ linkScroll: s.linkScroll, expanded: s.expanded }),
    }
  )
)

/**
 * A set of scroll boxes that follow each other (the answers of one compare
 * row). The box the user is scrolling is the source until it rests; scroll
 * events the others raise while following are ignored, so there is no loop.
 * A box only follows when it sits on the same line as the source (columns
 * side by side); stacked cells on a narrow screen never move each other.
 */
export function createScrollLink(isEnabled: () => boolean, restMs = 120) {
  const boxes = new Set<HTMLElement>()
  let source: HTMLElement | null = null
  let rest: ReturnType<typeof setTimeout> | null = null
  // Compared by the cards (headers can wrap to different heights), so two
  // columns side by side are on one line and stacked cells are not.
  const card = (el: HTMLElement) => (el.closest('article') as HTMLElement | null) ?? el
  const sameLine = (a: HTMLElement, b: HTMLElement) =>
    Math.abs(card(a).getBoundingClientRect().top - card(b).getBoundingClientRect().top) < 2
  return {
    add(el: HTMLElement) {
      boxes.add(el)
      return () => {
        boxes.delete(el)
        if (source === el) source = null
      }
    },
    /** Call from every box's scroll event. Returns how many boxes moved. */
    onScroll(el: HTMLElement): number {
      if (!isEnabled()) return 0
      if (source && source !== el) return 0
      source = el
      if (rest) clearTimeout(rest)
      rest = setTimeout(() => {
        source = null
      }, restMs)
      let moved = 0
      for (const other of boxes) {
        if (other === el || !sameLine(el, other)) continue
        const top = linkedScrollTop(el, other)
        if (top === null || Math.abs(other.scrollTop - top) < 1) continue
        other.scrollTop = top
        moved++
      }
      return moved
    },
  }
}
export type ScrollLink = ReturnType<typeof createScrollLink>

/** The answers of one compare row share a link; elsewhere there is none. */
export const ScrollLinkContext = createContext<ScrollLink | null>(null)
