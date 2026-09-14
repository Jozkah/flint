import { useEffect } from 'react'

/** Below this width Flint uses the phone layout. Matches Tailwind `md`. */
export const PHONE_MAX_WIDTH = 767

/**
 * Track the visual viewport so the shell and bottom sheets fit above an
 * on-screen keyboard and the browser's own chrome.
 *
 * - `--app-vvh` on <html>: the visible height in px.
 * - `kb-open` class on <html>: a phone-width layout whose visual viewport is
 *   substantially shorter than the layout viewport, i.e. a keyboard is up.
 *
 * Desktop windows never set `kb-open`.
 */
export function syncAppViewport(win: Window = window): void {
  const doc = win.document.documentElement
  const vv = win.visualViewport
  const height = Math.round(vv ? vv.height : win.innerHeight)
  doc.style.setProperty('--app-vvh', `${height}px`)
  const phone = win.innerWidth <= PHONE_MAX_WIDTH
  const keyboard = !!vv && win.innerHeight - vv.height > 140
  doc.classList.toggle('kb-open', phone && keyboard)
}

export function useAppViewport(): void {
  useEffect(() => {
    const sync = () => syncAppViewport(window)
    sync()
    const vv = window.visualViewport
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)
    window.addEventListener('resize', sync)
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
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])
}
