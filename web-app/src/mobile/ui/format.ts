// Formatting helpers shared by the phone's screens.
import type { RemoteToolStep, RoomDetail } from '@/lib/remote/protocol'
import { t } from '../i18n'

export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`
export const MARK = asset('images/flint-mark.png')

/** "3 minutes ago", "Yesterday", "12 Sep". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return t('format.justNow')
  const m = Math.round(s / 60)
  if (m < 60) return t('format.minAgo', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('format.hoursAgo', { n: h })
  const d = Math.round(h / 24)
  if (d === 1) return t('format.yesterday')
  if (d < 7) return t('format.daysAgo', { n: d })
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(n)
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function greet(h = new Date().getHours()) {
  return h < 12 ? t('format.goodMorning') : h < 18 ? t('format.goodAfternoon') : t('format.goodEvening')
}

/** Participant colours in a room, by position (the design's RC). */
export const SPEAKER_COLORS = ['#F87171', '#60A5FA', '#34D399', '#FBBF24', '#A78BFA', '#F472B6', '#22D3EE', '#FB923C']

/** A room speaker's colour, by position among the participants. */
export function speakerColor(room: RoomDetail, participantId: string) {
  const i = room.participants.findIndex((p) => p.id === participantId)
  return SPEAKER_COLORS[(i < 0 ? 0 : i) % SPEAKER_COLORS.length]
}

/** "Used read", "bash failed", as the desktop's timeline words it. */
export function toolLabel(s: RemoteToolStep): string {
  if (s.status === 'awaiting') return t('format.awaitingApproval', { name: s.name })
  if (s.status === 'failed') return t('format.failed', { name: s.name })
  if (s.status === 'running') return t('format.running', { name: s.name })
  return t('format.used', { name: s.name })
}

/** A readable default name for this phone. */
export function guessDeviceName(ua: string = globalThis.navigator?.userAgent ?? ''): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  const android = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)
  if (android?.[1] && !/^K$/.test(android[1].trim())) return android[1].trim()
  if (/Android/.test(ua)) return t('format.androidPhone')
  return t('format.phone')
}

/** How full a context window is, 0-100; 0 when the window is not known. */
export function contextPct(c: { usedTokens: number; windowTokens: number | null } | null | undefined): number {
  if (!c?.windowTokens) return 0
  return Math.min(100, Math.max(0, (c.usedTokens / c.windowTokens) * 100))
}

/** The desktop code viewer's reference form (lib/coworkCode codeRefToken),
 * which the desktop's prompt parser resolves to exactly those lines. */
export const codeRefToken = (path: string, a: number, b: number) => {
  const [s, e] = a <= b ? [a, b] : [b, a]
  return s === e ? `@${path}:${s}` : `@${path}:${s}-${e}`
}
