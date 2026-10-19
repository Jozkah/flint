/**
 * Bring `el` into view by moving only the nearest scrollable ancestor.
 *
 * `Element.scrollIntoView` also scrolls ancestors the user cannot scroll
 * (overflow: hidden panes), which left the Cowork transcript shifted off its
 * pane -- content in the DOM, nothing on screen -- until a reload.
 */
export function revealInScroller(el: Element, smooth: boolean): void {
  let parent = el.parentElement
  while (parent) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') break
    parent = parent.parentElement
  }
  if (!parent) return
  const box = el.getBoundingClientRect()
  const view = parent.getBoundingClientRect()
  let delta = 0
  if (box.bottom > view.bottom) delta = box.bottom - view.bottom
  else if (box.top < view.top) delta = box.top - view.top
  if (delta === 0) return
  const top = Math.max(0, parent.scrollTop + delta)
  if (smooth && typeof parent.scrollTo === 'function') {
    parent.scrollTo({ top, behavior: 'smooth' })
  } else {
    parent.scrollTop = top
  }
}
