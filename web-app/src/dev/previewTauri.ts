/**
 * Development-only: answers a few Tauri plugin commands with example data so
 * pages that read straight from a plugin (memory, permission history, folder
 * grants, agent memories and skills) show content in a plain browser.
 *
 * `@tauri-apps/api/core` reaches the backend through
 * `window.__TAURI_INTERNALS__`, which the app also reads to decide whether it
 * runs inside Tauri. The bridge is therefore handed out only to the Tauri API
 * functions themselves (judged by the calling frame); every other reader still
 * sees a plain browser, so no code path changes its mind about the platform.
 * Commands without an example answer reject, as they did before.
 */

type Handler = (args: Record<string, unknown>) => unknown

const handlers = new Map<string, Handler>()

/** Answer `cmd` (e.g. `plugin:agent-tools|memory_records_list`) with `fn`. */
export function answer(cmd: string, fn: Handler) {
  handlers.set(cmd, fn)
}

let nextCallback = 1
const bridge = {
  invoke(cmd: string, args: Record<string, unknown> = {}) {
    const fn = handlers.get(cmd)
    if (!fn) return Promise.reject(new Error(`${cmd} is not available in the browser preview`))
    try {
      return Promise.resolve(fn(args))
    } catch (error) {
      return Promise.reject(error)
    }
  },
  transformCallback: () => nextCallback++,
  unregisterCallback: () => {},
  convertFileSrc: (path: string) => path,
}

/** Frames of the Tauri API functions that read the bridge. */
const API_FRAME =
  /at (?:async )?(?:Object\.)?(invoke|transformCallback|unregisterCallback|convertFileSrc|cleanupCallback|Channel\.\w+) \(.*\/node_modules\//

let installed = false
export function installPreviewTauri() {
  if (installed || '__TAURI_INTERNALS__' in window) return
  installed = true
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    enumerable: false,
    get() {
      const caller = new Error().stack?.split('\n')[2] ?? ''
      return API_FRAME.test(caller) ? bridge : undefined
    },
  })
}
