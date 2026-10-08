// Web Push on the phone: whether this browser can, and turning it on and off.
// The computer sends the pushes itself (src-tauri/src/core/remote/push.rs).

import type { PushPrefs } from '@/lib/remote/protocol'
import { client } from './app'
import { registerServiceWorker } from '../sw/register'
import { t } from '../i18n'

export const DEFAULT_PUSH: PushPrefs = {
  approvals: true,
  runFinished: true,
  runFailed: true,
  pr: true,
  roomWaiting: true,
  synthesis: true,
  chatReply: false,
  hideContent: false,
  quietHours: { enabled: false, start: 22 * 60, end: 7 * 60 },
  utcOffsetMinutes: 0,
}

export type PushSupport =
  | { ok: true }
  | { ok: false; why: 'insecure' | 'ios-home-screen' | 'unsupported' }

type Env = {
  isSecureContext: boolean
  hasSw: boolean
  hasPush: boolean
  ios: boolean
  standalone: boolean
}

export function currentEnv(): Env {
  const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined
  const ua = nav?.userAgent ?? ''
  return {
    isSecureContext: !!globalThis.isSecureContext,
    hasSw: !!nav && 'serviceWorker' in nav,
    hasPush: 'PushManager' in globalThis && 'Notification' in globalThis,
    ios: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1),
    standalone: nav?.standalone === true || !!globalThis.matchMedia?.('(display-mode: standalone)').matches,
  }
}

/** iOS offers push only to a Home Screen web app (iOS 16.4+); everywhere,
 * only on a trusted HTTPS origin. */
export function pushSupport(env: Env = currentEnv()): PushSupport {
  if (!env.isSecureContext) return { ok: false, why: 'insecure' }
  if (env.ios && !env.standalone) return { ok: false, why: 'ios-home-screen' }
  if (!env.hasSw || !env.hasPush) return { ok: false, why: env.ios ? 'ios-home-screen' : 'unsupported' }
  return { ok: true }
}

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const minToTime = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export function timeToMin(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  return h < 24 && mm < 60 ? h * 60 + mm : null
}

/** The phone's offset from UTC, so quiet hours follow its clock. */
export const withOffset = (p: PushPrefs): PushPrefs => ({ ...p, utcOffsetMinutes: -new Date().getTimezoneOffset() })

/** Asks permission, subscribes with the computer's key and registers the
 * subscription. Returns a message on failure. */
export async function enablePush(prefs: PushPrefs): Promise<string | null> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return t('push.blocked')
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready)
  const { key } = await client().rpc('push.vapidKey', {})
  const existing = await reg.pushManager.getSubscription()
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) }))
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return t('push.incomplete')
  await client().rpc('push.subscribe', {
    subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    prefs: withOffset(prefs),
  })
  return null
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/m/')
    await (await reg?.pushManager.getSubscription())?.unsubscribe()
  } finally {
    await client().rpc('push.unsubscribe', {})
  }
}

export function supportText(s: PushSupport): string | null {
  if (s.ok) return null
  if (s.why === 'ios-home-screen')
    return t('push.ios')
  if (s.why === 'insecure')
    return t('push.insecure')
  return t('push.unsupported')
}
