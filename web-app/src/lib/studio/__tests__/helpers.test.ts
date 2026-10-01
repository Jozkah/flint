import { describe, expect, it } from 'vitest'
import {
  downloadedBytes,
  durationText,
  framesForSeconds,
  parseDownloadTask,
  parseSeed,
  phaseLabel,
  videoMemoryWarning,
} from '@/lib/studio/helpers'

describe('framesForSeconds', () => {
  it('gives 25, 49, 73 and 121 frames for 1, 2, 3 and 5 seconds at 24 fps', () => {
    expect([1, 2, 3, 5].map((s) => framesForSeconds(s, 24))).toEqual([25, 49, 73, 121])
  })

  it('always lands on four times something plus one, within range', () => {
    for (const fps of [16, 24, 30]) {
      for (const s of [0, 1, 2, 4, 9, 20]) {
        const n = framesForSeconds(s, fps)
        expect((n - 1) % 4).toBe(0)
        expect(n).toBeGreaterThanOrEqual(5)
        expect(n).toBeLessThanOrEqual(241)
      }
    }
  })
})

describe('parseSeed', () => {
  it('reads a whole number and leaves the rest random', () => {
    expect(parseSeed(' 42 ')).toBe(42)
    expect(parseSeed('0')).toBe(0)
    expect(parseSeed('')).toBeUndefined()
    expect(parseSeed('-1')).toBeUndefined()
    expect(parseSeed('1.5')).toBeUndefined()
    expect(parseSeed('4294967296')).toBeUndefined()
  })
})

describe('downloadedBytes', () => {
  const files = [{ size: 100 }, { size: 50 }, { size: 20 }]

  it('counts finished files in full and the current one as far as it got', () => {
    expect(downloadedBytes(files, 0, 30)).toBe(30)
    expect(downloadedBytes(files, 1, 10)).toBe(110)
    expect(downloadedBytes(files, 2, 20)).toBe(170)
  })

  it('never counts more than the current file holds', () => {
    expect(downloadedBytes(files, 1, 999)).toBe(150)
  })
})

describe('parseDownloadTask', () => {
  it('recognises this feature\'s task ids only', () => {
    expect(parseDownloadTask('diffusion:z-image-turbo:2')).toEqual({ modelId: 'z-image-turbo', index: 2 })
    expect(parseDownloadTask('diffusion:wan2.2-ti2v-5b:0')).toEqual({ modelId: 'wan2.2-ti2v-5b', index: 0 })
    expect(parseDownloadTask('hf:llamacpp:x:0')).toBeNull()
    expect(parseDownloadTask('diffusion:x:y')).toBeNull()
  })
})

describe('text helpers', () => {
  it('warns about video only on a small-memory machine', () => {
    expect(videoMemoryWarning(16 * 1024)).toContain('16 GB')
    expect(videoMemoryWarning(64 * 1024)).toBeNull()
    expect(videoMemoryWarning(undefined)).toBeNull()
  })

  it('names phases and formats durations', () => {
    expect(phaseLabel('sampling')).toBe('Drawing')
    expect(phaseLabel('nonsense')).toBe('Working')
    expect(durationText(3400)).toBe('3 s')
    expect(durationText(80_000)).toBe('1 min 20 s')
    expect(durationText(120_000)).toBe('2 min')
  })
})
