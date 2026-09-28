// Formatting helpers shared by the phone's screens.
import type { RemoteToolStep, RoomDetail } from '@/lib/remote/protocol'

export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`
export const MARK = asset('images/flint-mark.png')

/** "3 minutes ago", "Yesterday", "12 Sep". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d} days ago`
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
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
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
  if (s.status === 'awaiting') return `Awaiting approval: ${s.name}`
  if (s.status === 'failed') return `${s.name} failed`
  if (s.status === 'running') return `Running ${s.name}...`
  return `Used ${s.name}`
}

/** A readable default name for this phone. */
export function guessDeviceName(ua: string = globalThis.navigator?.userAgent ?? ''): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  const android = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)
  if (android?.[1] && !/^K$/.test(android[1].trim())) return android[1].trim()
  if (/Android/.test(ua)) return 'Android phone'
  return 'Phone'
}
