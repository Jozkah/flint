/**
 * Whether the browser client can still reach the `flint serve` that served
 * it. Without this a stopped server left the page looking healthy ("1 model
 * loaded", green) until a request failed.
 *
 * The server's `/healthz` needs no sign-in and is cheap: it is asked every
 * few seconds while the page is visible, at once when it comes back into view
 * or the browser says it is online again. Two failed looks in a row mark the
 * server offline; the first answer marks it online again.
 */
import { create } from 'zustand'

export type ServerConnectionState = 'online' | 'offline'

type Store = {
  state: ServerConnectionState
  failures: number
  report: (ok: boolean) => void
}

/** Failed looks in a row before the page says the server is gone. */
export const OFFLINE_AFTER = 2

export const useServerConnection = create<Store>()((set) => ({
  state: 'online',
  failures: 0,
  report: (ok) =>
    set((s) => {
      if (ok) return s.state === 'online' && s.failures === 0 ? s : { state: 'online', failures: 0 }
      const failures = s.failures + 1
      return { failures, state: failures >= OFFLINE_AFTER ? 'offline' : s.state }
    }),
}))

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** One look at the server: true when it answered. */
export async function checkServer(fetchImpl: FetchLike, timeoutMs = 4000): Promise<boolean> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetchImpl('/healthz', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: abort.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Keep `useServerConnection` current until the returned function is called.
 * Looks every `everyMs` while the page is visible; while the server is
 * offline it looks more often, so reconnecting shows quickly.
 */
export function startServerConnectionMonitor(
  options: { fetchImpl?: FetchLike; everyMs?: number; offlineEveryMs?: number } = {}
): () => void {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const everyMs = options.everyMs ?? 10_000
  const offlineEveryMs = options.offlineEveryMs ?? 3_000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false

  const look = async () => {
    if (stopped || inFlight) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    inFlight = true
    const ok = await checkServer(fetchImpl)
    inFlight = false
    if (!stopped) useServerConnection.getState().report(ok)
  }
  const schedule = () => {
    if (stopped) return
    const offline = useServerConnection.getState().state === 'offline'
    const failing = useServerConnection.getState().failures > 0
    timer = setTimeout(async () => {
      await look()
      schedule()
    }, offline || failing ? offlineEveryMs : everyMs)
  }
  const now = () => void look()

  if (typeof window !== 'undefined') {
    window.addEventListener('online', now)
    window.addEventListener('focus', now)
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', now)
  schedule()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', now)
      window.removeEventListener('focus', now)
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', now)
  }
}
