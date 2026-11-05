import { describe, it, expect } from 'vitest'
import { formatClock } from '../time'
import { formatDuration as roomDuration } from '@/containers/rooms/roomUi'
import { formatDuration as audioDuration } from '../artifactCardPreview'

// The pre-refactor bodies, kept verbatim as oracles.
const oldRoom = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
const oldAudio = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const msCases = [-5, 0, 400, 500, 999, 1000, 59_499, 59_500, 60_000, 187_000, 3_599_499, 3_600_000, 3_723_000, 86_400_000, 1e9]
const secCases = [NaN, Infinity, -1, 0, 0.4, 0.5, 1, 59.5, 60, 187, 3599.6, 3600, 3723, 90_000]

describe('formatClock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(187)).toBe('3:07')
    expect(formatClock(3723)).toBe('1:02:03')
  })
  it('room formatDuration is byte-identical to the old copy', () => {
    for (const ms of msCases) expect(roomDuration(ms)).toBe(oldRoom(ms))
  })
  it('audio formatDuration is byte-identical to the old copy', () => {
    for (const s of secCases) expect(audioDuration(s)).toBe(oldAudio(s))
  })
})
