/**
 * Stand-in for `@tauri-apps/api/event` in the browser build served by
 * `flint serve`. The Tauri event bus does not exist there; listeners register
 * and never fire, and `emit` reaches only listeners in this page.
 */

export type EventCallback<T> = (event: { event: string; id: number; payload: T }) => void
export type UnlistenFn = () => void

const listeners = new Map<string, Set<EventCallback<unknown>>>()
let nextId = 1

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const set = listeners.get(event) ?? new Set()
  set.add(handler as EventCallback<unknown>)
  listeners.set(event, set)
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
  for (const handler of listeners.get(event) ?? []) {
    handler({ event, id: nextId++, payload })
  }
}

export const TauriEvent = {} as Record<string, string>
