import type { StudioFile } from '@/lib/studio/studio'

/** Pure pieces of the Studio page, kept out of the component so they can be tested. */

export const IMAGE_SIZES: Array<{ label: string; width: number; height: number }> = [
  { label: 'Square 1024', width: 1024, height: 1024 },
  { label: 'Square 768', width: 768, height: 768 },
  { label: 'Square 512', width: 512, height: 512 },
  { label: 'Landscape 1344 × 768', width: 1344, height: 768 },
  { label: 'Portrait 768 × 1344', width: 768, height: 1344 },
]

export const VIDEO_SIZES: Array<{ label: string; width: number; height: number }> = [
  { label: '832 × 480', width: 832, height: 480 },
  { label: '960 × 544', width: 960, height: 544 },
  { label: '1280 × 704', width: 1280, height: 704 },
  { label: 'Square 704', width: 704, height: 704 },
  { label: 'Portrait 480 × 832', width: 480, height: 832 },
]

/** Clip lengths offered, in seconds. */
export const VIDEO_SECONDS = [1, 2, 3, 5]

/**
 * The frame count for a clip of `seconds`: a video model makes four times
 * something plus one, so the count is snapped to the nearest one at or below.
 * 1, 2, 3 and 5 seconds at 24 frames a second are 25, 49, 73 and 121 frames.
 */
export function framesForSeconds(seconds: number, fps: number): number {
  const wanted = Math.max(5, Math.round(seconds * fps) + 1)
  return Math.min(241, Math.floor((wanted - 1) / 4) * 4 + 1)
}

/** A seed the user typed: a whole number in range, or undefined for a random one. */
export function parseSeed(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return n <= 4_294_967_295 ? n : undefined
}

/**
 * Bytes downloaded so far across a model's files, which download one after
 * another: the files before `currentIndex` are complete, the current one is at
 * `currentBytes`.
 */
export function downloadedBytes(
  files: Pick<StudioFile, 'size'>[],
  currentIndex: number,
  currentBytes: number
): number {
  const done = files.slice(0, currentIndex).reduce((sum, f) => sum + f.size, 0)
  const current = files[currentIndex]
  return done + Math.min(currentBytes, current?.size ?? currentBytes)
}

/** `diffusion:z-image-turbo:2` is file 2 of that model; anything else is not ours. */
export function parseDownloadTask(taskId: string): { modelId: string; index: number } | null {
  const match = /^diffusion:(.+):(\d+)$/.exec(taskId)
  return match ? { modelId: match[1], index: Number(match[2]) } : null
}

/** Memory below which a video can take hours, because it swaps to disk. */
export const VIDEO_COMFORT_MB = 30 * 1024

export function videoMemoryWarning(totalMemoryMb: number | undefined): string | null {
  if (!totalMemoryMb || totalMemoryMb >= VIDEO_COMFORT_MB) return null
  const gb = Math.round(totalMemoryMb / 1024)
  return `This computer has about ${gb} GB of memory. Video generation needs a lot, and on a machine like this one clip can take hours because it runs out of memory and swaps to disk.`
}

const PHASES: Record<string, string> = {
  queued: 'Waiting',
  encoding: 'Reading the prompt',
  sampling: 'Drawing',
  decoding: 'Finishing',
  saving: 'Saving',
}

export function phaseLabel(phase: string): string {
  return PHASES[phase] ?? 'Working'
}

/** `3 s`, `1 min 20 s`: how long a generation took. */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}
