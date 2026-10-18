/**
 * Marks <html data-window-idle> while the window is hidden or does not have
 * focus. styles/perf.css pauses looping CSS animations (spinners, pulses,
 * pings) under the mark: each frame of them restyles the page, and with a
 * long thread open that was a third of the app's idle CPU while the user was
 * in another window. They resume, from where they were, on focus.
 */
export function installWindowIdleMarker(
  doc: Document = document,
  win: Window = window
): () => void {
  const root = doc.documentElement
  const update = () => {
    const idle = doc.visibilityState === 'hidden' || !doc.hasFocus()
    if (idle) root.setAttribute('data-window-idle', '')
    else root.removeAttribute('data-window-idle')
  }
  update()
  win.addEventListener('focus', update)
  win.addEventListener('blur', update)
  doc.addEventListener('visibilitychange', update)
  return () => {
    win.removeEventListener('focus', update)
    win.removeEventListener('blur', update)
    doc.removeEventListener('visibilitychange', update)
    root.removeAttribute('data-window-idle')
  }
}
