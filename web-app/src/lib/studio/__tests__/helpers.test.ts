import { describe, expect, it } from 'vitest'
import {
  downloadedBytes,
  downloadProgressText,
  durationText,
  estimateVideoMs,
  framesForSeconds,
  parseDownloadTask,
  parseSeed,
  IMAGE_SIZES,
  VIDEO_SIZES,
  phaseLabel,
  customSize,
  parseSide,
  sizeFor,
  snapSide,
  sizeIndexOf,
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

describe('estimateVideoMs', () => {
  const last = { width: 832, height: 480, frames: 49, steps: 30, durationMs: 600_000 }

  it('has no estimate without a clip to scale from', () => {
    expect(estimateVideoMs(undefined, { width: 832, height: 480, frames: 49, steps: 30 })).toBeNull()
    expect(estimateVideoMs({ ...last, durationMs: 0 }, { width: 832, height: 480, frames: 49, steps: 30 })).toBeNull()
  })

  it('repeats the time for the same work and scales with frames and size', () => {
    expect(estimateVideoMs(last, { width: 832, height: 480, frames: 49, steps: 30 })).toBe(600_000)
    expect(estimateVideoMs(last, { width: 832, height: 480, frames: 98, steps: 30 })).toBe(1_200_000)
    expect(estimateVideoMs(last, { width: 416, height: 240, frames: 49, steps: 30 })).toBe(150_000)
  })
})

describe('shapes', () => {
  it('makes standard proportions in multiples of 16 at about the same area', () => {
    expect(sizeFor(1, 1, 1024 * 1024)).toEqual({ width: 1024, height: 1024 })
    expect(sizeFor(16, 9, 1024 * 1024)).toEqual({ width: 1360, height: 768 })
    expect(sizeFor(9, 16, 1024 * 1024)).toEqual({ width: 768, height: 1360 })
    for (const s of [...IMAGE_SIZES, ...VIDEO_SIZES]) {
      expect(s.width % 16).toBe(0)
      expect(s.height % 16).toBe(0)
    }
  })

  it('keeps every shape inside what the models accept', () => {
    for (const s of IMAGE_SIZES) expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(2048)
    for (const s of VIDEO_SIZES) expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(1280)
  })

  it('finds the nearest shape for a size from an older list', () => {
    const wide = sizeIndexOf(IMAGE_SIZES, 1344, 768)
    expect(IMAGE_SIZES[wide].short).toBe('16:9')
    expect(sizeIndexOf(IMAGE_SIZES, 99999, 1)).toBe(IMAGE_SIZES.findIndex((s) => s.short === '21:9'))
    expect(sizeIndexOf(IMAGE_SIZES, 1024, 1024)).toBe(0)
  })
})

describe('custom resolution', () => {
  it('reads whole pixel counts only', () => {
    expect(parseSide(' 1024 ')).toBe(1024)
    for (const bad of ['', '12.5', '-8', 'abc', '1e3', '123456']) expect(parseSide(bad)).toBeNull()
  })

  it('snaps to multiples of 16 inside the model limits', () => {
    expect(snapSide(1000, 256, 2048)).toBe(1008)
    expect(snapSide(100, 256, 2048)).toBe(256)
    expect(snapSide(5000, 256, 2048)).toBe(2048)
    expect(snapSide(2047, 256, 2040)).toBe(2032)
  })

  it('uses the fallback for a box that is empty or not a number', () => {
    expect(customSize('1280', '720', { min: 256, max: 2048 }, 1024)).toEqual({ width: 1280, height: 720 })
    expect(customSize('', 'x', { min: 256, max: 2048 }, 1024)).toEqual({ width: 1024, height: 1024 })
    expect(customSize('3000', '64', { min: 256, max: 1280 }, 1024)).toEqual({ width: 1280, height: 256 })
  })
})

describe('downloadProgressText', () => {
  const fmt = (n: number) => `${n} B`

  it('says it is starting while nothing has arrived, never "unknown size"', () => {
    expect(downloadProgressText(0, 100, fmt)).toBe('Starting… 100 B to download')
    expect(downloadProgressText(0, 0, fmt)).toBe('Starting…')
  })

  it('shows progress against the total once bytes arrive', () => {
    expect(downloadProgressText(40, 100, fmt)).toBe('40 B of 100 B')
    expect(downloadProgressText(40, 0, fmt)).toBe('40 B')
  })
})
