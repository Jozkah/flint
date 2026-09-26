import { useEffect } from 'react'

/** Below this width Flint uses the phone layout. Matches Tailwind `md`. */
export const PHONE_MAX_WIDTH = 767

/**
 * Track the visual viewport so the shell and bottom sheets fit above an
 * on-screen keyboard and the browser's own chrome.
 *
 * - `--app-vvh` on <html>: the visible height in px, set only in a phone-width
 *   layout, where it can differ from the layout viewport. On a desktop window
 *   the property is removed and every user falls back to `100dvh`, which the
 *   engine resolves in the same layout pass as the resize. Writing the height
 *   from JS on every resize event invalidated style for the whole document a
 *   frame behind the real size, which made resizing the window sluggish.
 * - `kb-open` class on <html>: a phone-width layout whose visual viewport is
 *   substantially shorter than the layout viewport, i.e. a keyboard is up.
 *
 * Desktop windows never set `kb-open`.
 */
export function syncAppViewport(win: Window = window): void {
  const doc = win.document.documentElement
  const vv = win.visualViewport
  const phone = win.innerWidth <= PHONE_MAX_WIDTH
  if (phone) {
    const height = `${Math.round(vv ? vv.height : win.innerHeight)}px`
    if (doc.style.getPropertyValue('--app-vvh') !== height) {
      doc.style.setProperty('--app-vvh', height)
    }
  } else if (doc.style.getPropertyValue('--app-vvh')) {
    doc.style.removeProperty('--app-vvh')
  }
  const keyboard = !!vv && win.innerHeight - vv.height > 140
  const kb = phone && keyboard
  if (doc.classList.contains('kb-open') !== kb) doc.classList.toggle('kb-open', kb)
}

/** How long after the last resize event the window counts as still resizing. */
export const RESIZE_SETTLE_MS = 150

type Timers = {
  set: (fn: () => void, ms: number) => number
  clear: (id: number) => void
}

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
}

/**
 * Put `resizing` on an element (the <html> root) while the window is being
 * resized, and take it off once no resize event has arrived for `settleMs`.
 * The stylesheet uses it to switch off transitions, animations and backdrop
 * blur, which otherwise all repaint on every frame of a drag.
 */
export function createResizeFlag(
  root: HTMLElement,
  settleMs: number = RESIZE_SETTLE_MS,
  timers: Timers = windowTimers
): { poke: () => void; dispose: () => void } {
  let timer: number | null = null
  const settle = () => {
    timer = null
    root.classList.remove('resizing')
  }
  return {
    poke() {
      if (timer === null) root.classList.add('resizing')
      else timers.clear(timer)
      timer = timers.set(settle, settleMs)
    },
    dispose() {
      if (timer !== null) timers.clear(timer)
      settle()
    },
  }
}

export function useAppViewport(): void {
  useEffect(() => {
    const sync = () => syncAppViewport(window)
    sync()
    const flag = createResizeFlag(document.documentElement)
    const onWindowResize = () => {
      flag.poke()
      sync()
    }
    const vv = window.visualViewport
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('orientationchange', sync)
    // Keep the focused field visible once a phone keyboard has opened.
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null
      if (!el || window.innerWidth > PHONE_MAX_WIDTH) return
      if (!el.matches?.('input, textarea, [contenteditable="true"]')) return
      window.setTimeout(() => el.scrollIntoView?.({ block: 'nearest' }), 300)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      vv?.removeEventListener('resize', sync)
      vv?.removeEventListener('scroll', sync)
      window.removeEventListener('resize', onWindowResize)
      flag.dispose()
      window.removeEventListener('orientationchange', sync)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])
}
