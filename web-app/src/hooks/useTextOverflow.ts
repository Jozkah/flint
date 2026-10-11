import { useLayoutEffect, type RefObject } from 'react'

/**
 * Marks an element with `data-overflow="true"` while its text is wider than
 * its box, and removes the mark once it fits. The `text-fade` utility masks
 * the right edge only when the mark is present, so short labels stay crisp.
 *
 * Re-measures when the box resizes and when the text changes.
 */
export function observeTextOverflow(el: HTMLElement): () => void {
  const measure = () => {
    // +1: sub-pixel rounding must not read as overflow.
    if (el.scrollWidth > el.clientWidth + 1) el.setAttribute('data-overflow', 'true')
    else el.removeAttribute('data-overflow')
  }
  measure()
  const resize =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
  resize?.observe(el)
  const mutate =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure)
  mutate?.observe(el, { childList: true, characterData: true, subtree: true })
  // A web font swapping in reflows the text without resizing the box, so the
  // observers above never see it. Without this, a one-word label measured in
  // the fallback font keeps its fade for good.
  const fonts = typeof document === 'undefined' ? undefined : document.fonts
  fonts?.ready?.then(measure).catch(() => {})
  fonts?.addEventListener?.('loadingdone', measure)
  return () => {
    resize?.disconnect()
    mutate?.disconnect()
    fonts?.removeEventListener?.('loadingdone', measure)
  }
}

/**
 * Watch the element in `ref` for overflow. With `pick`, watch the element it
 * returns instead (for rows that fade a slotted label).
 */
export function useTextOverflow(
  ref: RefObject<HTMLElement | null>,
  pick?: (root: HTMLElement) => HTMLElement | null
) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const el = pick ? pick(root) : root
    if (!el) return
    return observeTextOverflow(el)
  })
}
