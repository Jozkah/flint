import { shellLog } from './shell'

let booted = false

/** Called once the app has rendered; later errors are logged, not shown full-screen. */
export function markBooted() {
  booted = true
}

/** Test hook: back to the pre-boot state. */
export function resetBootedForTests() {
  booted = false
}

/**
 * A thrown error at startup would otherwise leave a blank screen. After boot a
 * stray error or rejection (a failed fetch, a bad event) must not wipe a
 * working app, so it is only logged.
 */
export function showFatal(message: string) {
  shellLog('error', message.slice(0, 2000))
  if (booted) return
  const el = document.getElementById('root')
  if (!el || el.querySelector('[data-testid="fatal"]')) return
  const box = document.createElement('pre')
  box.dataset.testid = 'fatal'
  box.style.cssText = 'white-space:pre-wrap;padding:24px;font:13px ui-monospace,monospace;color:#c00'
  box.textContent = `Flint could not start.${String.fromCharCode(10)}${message}`
  el.replaceChildren(box)
}
