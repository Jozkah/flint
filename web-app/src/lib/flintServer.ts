/**
 * The Flint server this build is pointed at.
 *
 * The Android (and iOS) build has no agent, no remote server and no local
 * inference, but it can open a `flint serve` instance: the server hands out the
 * same web app over HTTPS, and that page speaks to the server through the
 * browser transport (`tauriBridgeShim`). So "connecting" is opening the
 * server's address. The sign-in happens on the server's own page and the
 * session lives in the WebView's cookie jar for that origin; nothing here ever
 * holds the administrator credential.
 *
 * Only the address is kept, in this origin's storage. Storage can be blocked
 * or wiped, so every access is guarded and the app behaves as unconfigured.
 */

const KEY = 'flint.server'
const SKIP_KEY = 'flint.server.skipped'

export type FlintServerConfig = {
  /** The server's base address, e.g. `https://studio.tail1234.ts.net` or
   * `https://host/flint` behind a reverse proxy. */
  url: string
  /** Open the server when the app starts, after a short chance to cancel. */
  autoConnect: boolean
}

export type UrlCheck =
  | { ok: true; url: string; insecure: boolean }
  | { ok: false; reason: 'empty' | 'invalid' | 'scheme' | 'credentials' }

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i

/**
 * An address typed by a person, reduced to the server's base address: the
 * origin plus any path (a server published under a prefix behind a reverse
 * proxy, e.g. `https://host/flint`), without a trailing slash. A bare host
 * gets `https://`. A query or fragment is dropped. Credentials in the address
 * are refused, so a token can never end up in a bookmark, a log or the
 * history. Addresses stored before paths were kept are plain origins and
 * read back unchanged.
 */
export function normalizeServerUrl(input: string): UrlCheck {
  const text = input.trim()
  if (!text) return { ok: false, reason: 'empty' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'scheme' }
  }
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials' }
  if (!parsed.hostname) return { ok: false, reason: 'invalid' }
  const path = parsed.pathname.replace(/\/+$/, '')
  return {
    ok: true,
    url: parsed.origin + path,
    // Plain HTTP sends the session in the clear. Android blocks it for
    // non-localhost addresses in a release build, so say so up front.
    insecure: parsed.protocol === 'http:' && !LOCAL_HOST.test(parsed.hostname),
  }
}

export function loadServerConfig(storage: Storage | undefined = safeStorage()): FlintServerConfig | null {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<FlintServerConfig>
    if (typeof value.url !== 'string') return null
    const check = normalizeServerUrl(value.url)
    if (!check.ok) return null
    return { url: check.url, autoConnect: value.autoConnect === true }
  } catch {
    return null
  }
}

export function saveServerConfig(
  config: FlintServerConfig,
  storage: Storage | undefined = safeStorage()
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(config))
  } catch {
    // Blocked storage: the setting simply does not stick.
  }
}

export function clearServerConfig(storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}

/** Set when the person chose this device over the server for this session. */
export function skipAutoConnect(storage: Storage | undefined = safeSession()): void {
  try {
    storage?.setItem(SKIP_KEY, '1')
  } catch {
    // Without it the countdown shows again on the next launch; harmless.
  }
}

export function autoConnectSkipped(storage: Storage | undefined = safeSession()): boolean {
  try {
    return storage?.getItem(SKIP_KEY) === '1'
  } catch {
    return false
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function safeSession(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

export type ServerProbe =
  /** The server answered `/healthz` and said it is Flint. */
  | { state: 'ok' }
  /**
   * Something answered, but its reply cannot be read from this origin (the
   * server was not started with `--allowed-origin` for this app), so it is not
   * known to be Flint.
   */
  | { state: 'reachable' }
  | { state: 'unreachable'; detail: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Is there a Flint server at `url`? `/healthz` needs no sign-in. A cross-origin
 * read of it works only when the server allows this app's origin; without that
 * the opaque answer still proves the address is reached.
 */
export async function probeServer(
  url: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<ServerProbe> {
  const fetchImpl: FetchLike | undefined =
    options.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined)
  if (!fetchImpl) return { state: 'unreachable', detail: 'no network access' }
  const target = `${url}/healthz`
  const attempt = async (init: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
    try {
      return await fetchImpl(target, { ...init, signal: controller.signal, cache: 'no-store' })
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const response = await attempt({ credentials: 'omit' })
    const body = (await response.text()).trim()
    if (response.ok && body === 'ok') return { state: 'ok' }
    return { state: 'reachable' }
  } catch (readable) {
    // A blocked cross-origin read looks the same as an unreachable host, so
    // ask again in a way that can only fail when nothing answers.
    try {
      await attempt({ mode: 'no-cors', credentials: 'omit' })
      return { state: 'reachable' }
    } catch (error) {
      const source = error ?? readable
      return {
        state: 'unreachable',
        detail: source instanceof Error ? source.message : String(source),
      }
    }
  }
}
