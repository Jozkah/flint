/**
 * Stand-in for `@tauri-apps/api/event` in the browser build served by
 * `flint serve`.
 *
 * Events the server publishes (model load progress, engine faults) arrive on
 * one server-sent-events stream, opened when the first listener registers and
 * reopened after a drop. `emit` reaches listeners in this page only, as before.
 */

export type EventCallback<T> = (event: { event: string; id: number; payload: T }) => void
export type UnlistenFn = () => void

const listeners = new Map<string, Set<EventCallback<unknown>>>()
let nextId = 1

function dispatch(event: string, payload: unknown): void {
  for (const handler of [...(listeners.get(event) ?? [])]) {
    try {
      handler({ event, id: nextId++, payload })
    } catch (error) {
      console.warn(`listener for '${event}' threw`, error)
    }
  }
}

const LINE_BREAK = String.fromCharCode(10)
let streaming = false

/** Read one connection of the server's event stream until it ends. */
async function readStream(): Promise<'ended' | 'unavailable'> {
  const response = await fetch('/api/v1/events', { credentials: 'same-origin' })
  const type = response.headers?.get('content-type') ?? ''
  if (!response.ok || response.redirected || !response.body || !type.includes('text/event-stream')) {
    return 'unavailable'
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return 'ended'
    buffered += decoder.decode(value, { stream: true })
    let end = buffered.indexOf(LINE_BREAK + LINE_BREAK)
    while (end >= 0) {
      const block = buffered.slice(0, end)
      buffered = buffered.slice(end + 2)
      for (const line of block.split(LINE_BREAK)) {
        if (!line.startsWith('data:')) continue
        try {
          const message = JSON.parse(line.slice(5).trim()) as { event?: string; payload?: unknown }
          if (typeof message.event === 'string') dispatch(message.event, message.payload)
        } catch {
          // A malformed line is skipped; the stream carries on.
        }
      }
      end = buffered.indexOf(LINE_BREAK + LINE_BREAK)
    }
  }
}

/** Keep the stream open while anyone is listening. */
async function keepStreaming(): Promise<void> {
  let delay = 1000
  while ([...listeners.values()].some((set) => set.size > 0)) {
    try {
      const outcome = await readStream()
      // Not signed in (or no event stream here): stop asking so often.
      delay = outcome === 'unavailable' ? Math.min(delay * 2, 60000) : 1000
    } catch {
      delay = Math.min(delay * 2, 30000)
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  streaming = false
}

function ensureStreaming(): void {
  if (streaming || typeof fetch !== 'function') return
  streaming = true
  void keepStreaming()
}

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const set = listeners.get(event) ?? new Set()
  set.add(handler as EventCallback<unknown>)
  listeners.set(event, set)
  ensureStreaming()
  return () => {
    set.delete(handler as EventCallback<unknown>)
  }
}

export async function once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (e) => {
    unlisten()
    handler(e)
  })
  return unlisten
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  dispatch(event, payload)
}

export const TauriEvent = {} as Record<string, string>
