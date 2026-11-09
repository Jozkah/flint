import { describe, it, expect, vi, afterEach } from 'vitest'
import en from '@/locales/en/common.json'
import { timeAgo as roomTimeAgo } from '@/containers/rooms/roomUi'
import { relativeTime } from '../codeGutter'
import { formatElapsed } from '../runStatus'
import { formatDuration as spanText } from '../utils'
import { formatDuration as campaignDuration } from '../campaignStory'
import { contextAge as contextAgo } from '../contextUsage'
import { formatDuration as studioDuration, timeAgo as studioTimeAgo } from '@/containers/studio/studioHelpers'
import { ageParts, formatDuration, timeAgo } from '../time'

// Every caller of the shared duration and age helpers, checked against the
// body it had before it was moved onto `lib/time.ts`. Exact where the wording
// was kept; a before/after table where it was unified.

/** English `common` strings, with i18next-style interpolation. */
const enT = (key: string, options?: Record<string, unknown>) => {
  const path = key.replace(/^common:/, '').split('.')
  let v: unknown = en
  for (const p of path) v = (v as Record<string, unknown>)[p]
  return String(v).replace(/\{\{(\w+)\}\}/g, (_, k) => String(options?.[k]))
}
/** Studio's `t`, with the keys it still owns. */
const studioT = (key: string, options?: Record<string, unknown>) =>
  key === 'studio:time.fewSeconds' ? 'a few seconds ago' : enT(key, options)

// ---- The pre-refactor bodies, verbatim, as oracles ------------------------

const oldRoomTimeAgo = (at: number, lang = 'en', now = Date.now()): string => {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const steps: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
  ]
  let v = (at - now) / 1000
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit)
    v /= size
  }
  return rtf.format(Math.round(v), 'year')
}
const oldRelativeTime = (seconds: number, now: number) => {
  const diff = Math.max(0, now - seconds)
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ]
  for (const [size, unit] of steps) {
    if (diff >= size) return { value: -Math.floor(diff / size), unit }
  }
  return { value: 0, unit: 'second' }
}
const oldElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
const oldSpan = (startTime: number, endTime?: number) => {
  const end = endTime || Date.now()
  const durationMs = end - startTime
  if (durationMs < 0) return 'Invalid duration (start time is in the future)'
  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  if (seconds > 0) return `${seconds}s`
  return `${durationMs}ms`
}
const oldContextAgo = (ms: number): string | null => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return null
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} days ago`
}
const oldStudioTimeAgo = (ms: number, language: string, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 20) return 'a few seconds ago'
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (s < 90) return rtf.format(-1, 'minute')
  const m = Math.round(s / 60)
  if (m < 60) return rtf.format(-m, 'minute')
  const h = Math.round(m / 60)
  if (h < 24) return rtf.format(-h, 'hour')
  return rtf.format(-Math.round(h / 24), 'day')
}
const oldBackgroundAgo = (ms: number) => `${Math.round(ms / 1000)}s`
const oldPhoneAgoParts = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'justNow'
  const m = Math.round(s / 60)
  if (m < 60) return `min:${m}`
  const h = Math.round(m / 60)
  if (h < 24) return `hour:${h}`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `day:${d}`
  return 'date'
}

// ---- Inputs ----------------------------------------------------------------

const NOW = 1_700_000_000_000
const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H
// Every unit boundary, either side of it, and a spread in between.
const boundaries = [0, 1, 499, 500, 999, S, 1.5 * S, 2.5 * S, 19 * S, 20 * S, 29_999, 30 * S, 44_499, 44_500, 45 * S, 59_499, 59_500, 59_999, M, 89_499, 89_500, 90 * S, 30 * M, 59 * M, 3_569_999, 3_570_000, H, 1.5 * H, 23 * H, 23.5 * H, D, 36 * H, 47 * H, 48 * H, 3 * D, 6.5 * D, 7 * D, 13 * D, 29 * D, 30 * D, 31 * D, 200 * D, 364 * D, 365 * D, 400 * D, 4000 * D]
const spread = Array.from({ length: 4000 }, (_, i) => Math.round(Math.pow(1.0055, i) * 37) % (5000 * D))
const ages = [...boundaries, ...spread]

afterEach(() => {
  vi.useRealTimers()
})

describe('ages kept exactly', () => {
  it('rooms and campaigns (Intl, auto) match the old body, past and future', () => {
    for (const lang of ['en', 'de-DE', 'ja']) {
      for (const a of ages) {
        expect(roomTimeAgo(NOW - a, lang, NOW)).toBe(oldRoomTimeAgo(NOW - a, lang, NOW))
        expect(roomTimeAgo(NOW + a, lang, NOW)).toBe(oldRoomTimeAgo(NOW + a, lang, NOW))
      }
    }
  })

  it('code gutter blame age matches the old body', () => {
    const now = NOW / 1000
    for (const a of ages) {
      const seconds = now - Math.floor(a / 1000)
      expect(relativeTime(seconds, now)).toEqual(oldRelativeTime(seconds, now))
    }
    expect(relativeTime(now + 100, now)).toEqual(oldRelativeTime(now + 100, now))
  })

  it('context window age matches the old English and is localised', () => {
    // Intl groups digits past 999 ("1,200 days ago"); the old body did not.
    for (const a of [-5, ...ages].filter((x) => x < 1000 * D)) {
      expect(contextAgo(a, 'en')).toBe(oldContextAgo(a))
    }
    expect(contextAgo(2 * H, 'de-DE')).toBe('vor 2 Stunden')
    expect(contextAgo(3 * D, 'fr')).toBe('il y a 3 jours')
  })

  it('studio age matches the old body', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    for (const lang of ['en', 'fr']) {
      for (const a of [-5 * S, ...ages]) {
        expect(studioTimeAgo(NOW - a, studioT, lang)).toBe(oldStudioTimeAgo(NOW - a, lang, NOW))
      }
    }
  })

  it('phone age buckets match the old body', () => {
    // The phone formats the bucket with its own strings; the bucket is shared.
    const units = [
      { unit: 'second' as const, seconds: 1, until: 45 },
      { unit: 'minute' as const, seconds: 60 },
      { unit: 'hour' as const, seconds: 3600 },
      { unit: 'day' as const, seconds: 86_400, until: 7 * 86_400 },
      { unit: 'week' as const, seconds: 7 * 86_400 },
    ]
    for (const a of [-5 * S, ...ages]) {
      const { value, unit } = ageParts(NOW - a, { now: NOW, units, cascade: true, pastOnly: true })
      const n = Math.abs(value)
      const got =
        unit === 'second'
          ? 'justNow'
          : unit === 'minute'
            ? `min:${n}`
            : unit === 'hour'
              ? `hour:${n}`
              : unit === 'day'
                ? n === 1
                  ? 'yesterday'
                  : `day:${n}`
                : 'date'
      expect(got).toBe(oldPhoneAgoParts(NOW - a, NOW))
    }
  })
})

describe('durations kept exactly', () => {
  it('run elapsed ("1m 05s") matches the old body', () => {
    for (const ms of [-500, ...ages]) expect(formatElapsed(ms)).toBe(oldElapsed(ms))
  })

  it('activity span ("2h 11m 30s", "500ms") matches the old body', () => {
    for (const ms of ages) expect(spanText(NOW, NOW + ms)).toBe(oldSpan(NOW, NOW + ms))
    expect(spanText(NOW, NOW - 5)).toBe(oldSpan(NOW, NOW - 5))
  })

  it('background task age ("12s") matches the old body', () => {
    for (const ms of [-1400, -400, ...ages]) {
      expect(formatDuration(ms, { style: 'units', largest: 'second' })).toBe(oldBackgroundAgo(ms))
    }
  })
})

describe('durations unified onto the short units', () => {
  // Same meaning, one wording: Studio and the campaign board now say what the
  // tool rows, task panels and chain of thought already said.
  const table: Array<[string, number, string, string]> = [
    // [surface, ms, before, after]
    ['campaign', 500, '1 s', '1s'],
    ['campaign', 45_000, '45 s', '45s'],
    ['campaign', 180_000, '3 min', '3m'],
    ['campaign', 3_600_000, '1 h 00 min', '1h'],
    ['campaign', 3_900_000, '1 h 05 min', '1h 5m'],
    ['studio', 3_400, '3 s', '3s'],
    ['studio', 80_000, '1 min 20 s', '1m 20s'],
    ['studio', 120_000, '2 min', '2m'],
    ['studio', 3_720_000, '62 min', '62m'],
  ]

  it.each(table)('%s %d ms: %s -> %s', (surface, ms, _before, after) => {
    const got = surface === 'campaign' ? campaignDuration(ms, enT) : studioDuration(enT, ms)
    expect(got).toBe(after)
  })

  it('timeAgo defaults to English, auto wording', () => {
    expect(timeAgo(NOW - D, { now: NOW })).toBe('yesterday')
    expect(timeAgo(NOW - 2 * H, { now: NOW, numeric: 'always' })).toBe('2 hours ago')
  })
})
