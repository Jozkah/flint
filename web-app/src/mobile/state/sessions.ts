import type { SessionKind, SessionSummary } from '@/lib/remote/protocol'
import { useRpc } from './rpc'
import type { Route } from './router'

export const SESSIONS_PARAMS = { limit: 200 } as const

/** Every conversation on the computer, newest first. */
export function useSessions() {
  const r = useRpc('sessions.list', SESSIONS_PARAMS)
  return { ...r, sessions: r.data?.sessions ?? [] }
}

export function byKind(sessions: SessionSummary[], kind: SessionKind) {
  return sessions.filter((s) => s.kind === kind)
}

/** Sessions grouped by their group label, groups in first-seen order. */
export function grouped(sessions: SessionSummary[]) {
  const groups = new Map<string, SessionSummary[]>()
  const loose: SessionSummary[] = []
  for (const s of sessions) {
    if (!s.group) loose.push(s)
    else groups.set(s.group, [...(groups.get(s.group) ?? []), s])
  }
  return { groups: [...groups.entries()], loose }
}

/** Where a conversation id lives; Cowork when unknown (approvals come from
 * Cowork most often). */
export function routeFor(id: string, sessions: SessionSummary[]): Route {
  const s = sessions.find((x) => x.id === id)
  return { name: s?.kind ?? 'cowork', id }
}

/** How the phone reaches the computer, from the address it was opened at. */
export function reachLabel(host: string = globalThis.location?.hostname ?? ''): string {
  if (/\.ts\.net$/i.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'Tailscale'
  if (host === 'localhost' || host.startsWith('127.')) return 'This computer'
  return 'Local network'
}
