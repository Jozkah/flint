// The service worker's decisions, kept free of worker globals so they are
// unit-tested (src/mobile/__tests__/sw.test.ts). sw.ts wires them up.

import { REMOTE_API_PREFIX, type PushPayload } from '@/lib/remote/protocol'

export const APP_SCOPE = '/m/'

export type ShownNotification = {
  title: string
  options: NotificationOptions & { actions?: { action: string; title: string }[]; renotify?: boolean }
}

/** Anything not an in-app path opens the app's root. */
export function safeUrl(url: unknown): string {
  return typeof url === 'string' && url.startsWith(APP_SCOPE) && !url.includes('//') ? url : APP_SCOPE
}

/** What to show for a push. An unreadable payload still shows something:
 * browsers penalise a push that shows nothing (`userVisibleOnly`). */
export function notificationFor(raw: unknown): ShownNotification {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<PushPayload>
  const title = typeof p.title === 'string' && p.title ? p.title : 'Flint needs you'
  const data: PushPayload = {
    title,
    body: typeof p.body === 'string' ? p.body : '',
    url: safeUrl(p.url),
    tag: typeof p.tag === 'string' ? p.tag : '',
    category: p.category ?? 'test',
    ...(typeof p.requestId === 'string' ? { requestId: p.requestId } : {}),
  }
  const options: ShownNotification['options'] = {
    body: data.body,
    data,
    icon: `${APP_SCOPE}icons/icon-192.png`,
    badge: `${APP_SCOPE}icons/icon-192.png`,
  }
  if (data.tag) {
    options.tag = data.tag
    options.renotify = data.category === 'approval'
  }
  if (data.category === 'approval' && data.requestId) {
    options.actions = [
      { action: 'allow', title: 'Allow once' },
      { action: 'deny', title: 'Deny' },
    ]
    options.requireInteraction = true
  }
  return { title, options }
}

export type ClickPlan =
  | { kind: 'respond'; requestId: string; decision: 'allow' | 'deny'; url: string }
  | { kind: 'open'; url: string }

export function planClick(action: string, data: unknown): ClickPlan {
  const d = (data && typeof data === 'object' ? data : {}) as Partial<PushPayload>
  const url = safeUrl(d.url)
  if ((action === 'allow' || action === 'deny') && d.category === 'approval' && typeof d.requestId === 'string') {
    return { kind: 'respond', requestId: d.requestId, decision: action, url }
  }
  return { kind: 'open', url }
}

export type RespondResult = 'answered' | 'gone' | 'unpaired' | 'refused' | 'failed'

/** Answers an approval from the notification: an authenticated RPC with the
 * token the page mirrored into IndexedDB. "Allow once" only, never broader. */
export async function respondFromNotification(
  requestId: string,
  decision: 'allow' | 'deny',
  deps: { token: () => Promise<string | null>; fetch: typeof fetch; origin: string }
): Promise<RespondResult> {
  const token = await deps.token()
  if (!token) return 'unpaired'
  try {
    const res = await deps.fetch(`${deps.origin}${REMOTE_API_PREFIX}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: `sw-${requestId}`,
        method: 'approvals.respond',
        params: { requestId, decision, scope: 'once' },
      }),
    })
    if (res.status === 401) return 'unpaired'
    if (res.status === 403) return 'refused'
    if (!res.ok) return 'failed'
    const body = (await res.json()) as { result?: { status?: string }; error?: unknown }
    if (body.error) return 'refused'
    return body.result?.status === 'gone' ? 'gone' : 'answered'
  } catch {
    return 'failed'
  }
}

type WindowClientLike = { url: string; focus: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }

/** Focuses an open window of the app (moving it to `url`), or opens one. */
export async function openApp(
  url: string,
  clients: { matchAll: (o: { type: 'window'; includeUncontrolled: boolean }) => Promise<readonly WindowClientLike[]>; openWindow: (url: string) => Promise<unknown> },
  origin: string
): Promise<void> {
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true })
  const mine = list.find((c) => {
    try {
      return new URL(c.url).pathname.startsWith(APP_SCOPE)
    } catch {
      return false
    }
  })
  if (mine) {
    if (mine.navigate) await mine.navigate(`${origin}${url}`).catch(() => undefined)
    await mine.focus()
    return
  }
  await clients.openWindow(`${origin}${url}`)
}

export const RESULT_TEXT: Record<Exclude<RespondResult, 'answered'>, string> = {
  gone: 'That approval was already answered or its run ended.',
  unpaired: 'This phone is not paired any more. Open Flint to pair again.',
  refused: 'Your computer refused that answer. Open Flint to see why.',
  failed: "Couldn't reach your computer. Open Flint to answer.",
}
