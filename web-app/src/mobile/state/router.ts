// The phone app's routes, kept in the URL hash (`#/cowork/<id>`), so the
// browser's and Android's back gesture walk back through them and a reload
// keeps the screen. `#pair=...` is the pairing link and is not a route.

import type { SessionKind } from '@/lib/remote/protocol'

export type HomeMode = 'chat' | 'cowork' | 'room'

export type Route =
  | { name: 'home'; mode?: HomeMode }
  | { name: 'chat'; id: string }
  | { name: 'cowork'; id: string }
  | { name: 'room'; id: string }
  | { name: 'rooms' }
  | { name: 'overview' }
  | { name: 'library' }
  | { name: 'studio' }
  | { name: 'archive' }
  | { name: 'models' }
  | { name: 'hf' }
  | { name: 'tools' }
  | { name: 'system' }
  | { name: 'notifications' }
  | { name: 'settings' }
  | { name: 'settings-sub'; sub: string }
  | { name: 'remote' }

const SIMPLE = [
  'rooms',
  'overview',
  'library',
  'studio',
  'archive',
  'models',
  'hf',
  'tools',
  'system',
  'notifications',
  'settings',
  'remote',
] as const

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'home':
      return r.mode && r.mode !== 'chat' ? `#/new/${r.mode}` : '#/'
    case 'chat':
    case 'cowork':
    case 'room':
      return `#/${r.name}/${encodeURIComponent(r.id)}`
    case 'settings-sub':
      return `#/settings/${encodeURIComponent(r.sub)}`
    default:
      return `#/${r.name}`
  }
}

function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

export function hashToRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const decoded = raw.map(safeDecode)
  if (decoded.some((part) => part === null)) return { name: 'home' }
  const parts = decoded as string[]
  const [head, arg] = parts
  if (!head) return { name: 'home' }
  if (head === 'new' && (arg === 'cowork' || arg === 'room' || arg === 'chat')) return { name: 'home', mode: arg }
  if ((head === 'chat' || head === 'cowork' || head === 'room') && arg) return { name: head, id: arg }
  if (head === 'settings' && arg) return { name: 'settings-sub', sub: arg }
  if ((SIMPLE as readonly string[]).includes(head)) return { name: head } as Route
  return { name: 'home' }
}

export const sessionRoute = (kind: SessionKind, id: string): Route => ({ name: kind, id })

/** Reads `#pair=<code>&name=<computer>` from a pairing link. */
export function readPairingFragment(hash: string): { code: string; computer?: string } | null {
  try {
    const m = hash.replace(/^#/, '')
    if (!m.startsWith('pair=')) return null
    const params = new URLSearchParams(m)
    const code = params.get('pair')?.trim()
    if (!code) return null
    const computer = params.get('name')?.trim()
    return computer ? { code, computer } : { code }
  } catch {
    return null
  }
}
