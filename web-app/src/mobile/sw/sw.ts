// The phone app's service worker (built to /m/sw.js, scope /m/): shows Web
// Push notifications, opens the app at the notification's link, and answers
// approvals from the notification's buttons. It caches nothing: the app
// needs the computer anyway.

import { idbGet, TOKEN_KEY } from '../api/idb'
import { LANGUAGE_KEY, setLanguage } from '../i18n'
import { notificationFor, openApp, planClick, respondFromNotification, resultText } from './logic'

/** The worker has no localStorage: the page mirrors its language into
 * IndexedDB (main.tsx). Without a mirror the worker uses the browser's. */
async function loadLanguage() {
  setLanguage(await idbGet<string>(LANGUAGE_KEY))
}

// Worker types, declared here rather than with `lib: webworker`, which
// would clash with the DOM types the rest of the app compiles against.
type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void }
type PushEvent = ExtendableEvent & { data: { json(): unknown } | null }
type NotificationEvent = ExtendableEvent & { action: string; notification: Notification }
type WorkerClients = Parameters<typeof openApp>[1] & { claim(): Promise<void> }
type SwScope = {
  location: Location
  clients: WorkerClients
  registration: ServiceWorkerRegistration
  skipWaiting(): Promise<void>
  addEventListener(t: 'install' | 'activate', f: (e: ExtendableEvent) => void): void
  addEventListener(t: 'push', f: (e: PushEvent) => void): void
  addEventListener(t: 'notificationclick', f: (e: NotificationEvent) => void): void
}
declare const self: SwScope

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let raw: unknown = null
  try {
    raw = e.data?.json()
  } catch {
    raw = null
  }
  e.waitUntil(
    (async () => {
      await loadLanguage()
      const n = notificationFor(raw)
      await self.registration.showNotification(n.title, n.options)
    })()
  )
})

self.addEventListener('notificationclick', (e) => {
  const plan = planClick(e.action, e.notification.data)
  e.notification.close()
  const origin = self.location.origin
  e.waitUntil(
    (async () => {
      if (plan.kind === 'open') return openApp(plan.url, self.clients, origin)
      const r = await respondFromNotification(plan.requestId, plan.decision, {
        token: () => idbGet<string>(TOKEN_KEY),
        fetch: (...a) => fetch(...a),
        origin,
      })
      if (r !== 'answered') {
        await loadLanguage()
        await self.registration.showNotification('Flint', {
          body: resultText(r),
          tag: `approval-${plan.requestId}`,
          data: { url: plan.url, category: 'test', title: 'Flint', body: '', tag: '' },
        })
      }
    })()
  )
})
