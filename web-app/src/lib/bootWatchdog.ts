/**
 * A bound on the start-up splash. The splash is plain HTML in index.html and
 * only the extension setup removes it, so a stall before that point (a module
 * that never loads, a boot step that throws) leaves "Starting your workspace…"
 * on screen for ever with nothing to act on. After `ms` the caption turns into
 * a message that says what to try. A boot that finishes in time never sees it;
 * one that finishes later still removes the splash as usual.
 *
 * Plain English, not t(): the i18n bundle is one of the things that may be
 * what stalled.
 */
export const BOOT_STALL_MS = 20_000

export const BOOT_STALL_MESSAGE =
  'Starting is taking longer than expected. Reload the page; if it keeps ' +
  'stalling, open the browser console (F12) and look for the first error.'

/** The desktop app has no address bar or F12: say what happened, offer Reload. */
export const BOOT_STALL_MESSAGE_APP =
  'Starting is taking longer than expected. It may still finish; if it does ' +
  'not, reload.'

const isDesktopApp = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// The first thing that went wrong while starting, shown on the stalled splash
// so a stall names its cause instead of only saying "something is slow".
let firstError: string | null = null

const errorLine = (e: unknown): string => {
  const text =
    e instanceof Error ? e.message : typeof e === 'string' ? e : String(e ?? '')
  return text.split(/\r?\n/)[0].slice(0, 200)
}

/** Remember an error from start-up (first one wins). */
export function noteBootError(e: unknown): void {
  if (firstError) return
  const line = errorLine(e)
  if (line) firstError = line
}

/** For tests. */
export function resetBootErrors(): void {
  firstError = null
}

function showStall(loader: HTMLElement, ms: number): void {
  const caption = document.getElementById('initial-loader-caption')
  if (caption) {
    const base = isDesktopApp() ? BOOT_STALL_MESSAGE_APP : BOOT_STALL_MESSAGE
    caption.textContent = firstError ? `${base} (${firstError})` : base
  }
  // The bar stops sliding (CSS keys off this) so it does not look busy or done.
  loader.setAttribute('data-stalled', 'true')
  if (!document.getElementById('initial-loader-reload')) {
    const button = document.createElement('button')
    button.id = 'initial-loader-reload'
    button.type = 'button'
    button.textContent = 'Reload'
    button.addEventListener('click', () => window.location.reload())
    loader.appendChild(button)
  }
  console.error(
    `Boot did not finish within ${ms / 1000}s.` +
      (firstError ? ` First error: ${firstError}` : '')
  )
}

export function startBootWatchdog(ms: number = BOOT_STALL_MS): () => void {
  const onError = (e: ErrorEvent) => noteBootError(e.error ?? e.message)
  const onRejection = (e: PromiseRejectionEvent) => noteBootError(e.reason)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  const timer = setTimeout(() => {
    const loader = document.getElementById('initial-loader')
    if (!loader || document.body.classList.contains('loaded')) return
    showStall(loader, ms)
  }, ms)
  return () => {
    clearTimeout(timer)
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
