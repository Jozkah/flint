import type { StudioFile } from '@/lib/studio/studio'

/** Pure pieces of the Studio page, kept out of the component so they can be tested. */

export type StudioSize = { label: string; short: string; width: number; height: number }

/** Sides are multiples of 16, which is what the engine accepts. */
const snap = (n: number) => Math.max(16, Math.round(n / 16) * 16)

/**
 * A standard shape at about `area` pixels: `ratio` is width over height. The
 * same picture area at every shape, so a wide picture costs what a square one
 * does and none of them is much slower or hungrier than the others.
 */
export function sizeFor(ratioW: number, ratioH: number, area: number): { width: number; height: number } {
  const width = snap(Math.sqrt((area * ratioW) / ratioH))
  return { width, height: snap(area / width) }
}

const shape = (name: string, ratioW: number, ratioH: number, area: number): StudioSize => {
  const { width, height } = sizeFor(ratioW, ratioH, area)
  return { label: `${name} ${ratioW}:${ratioH} · ${width} × ${height}`, short: `${ratioW}:${ratioH}`, width, height }
}

const IMAGE_AREA = 1024 * 1024
const VIDEO_AREA = 832 * 480

export const IMAGE_SIZES: StudioSize[] = [
  shape('Square', 1, 1, IMAGE_AREA),
  shape('Landscape', 4, 3, IMAGE_AREA),
  shape('Portrait', 3, 4, IMAGE_AREA),
  shape('Photo', 3, 2, IMAGE_AREA),
  shape('Tall photo', 2, 3, IMAGE_AREA),
  shape('Widescreen', 16, 9, IMAGE_AREA),
  shape('Vertical', 9, 16, IMAGE_AREA),
  shape('Cinema', 21, 9, IMAGE_AREA),
]

export const VIDEO_SIZES: StudioSize[] = [
  shape('Widescreen', 16, 9, VIDEO_AREA),
  shape('Vertical', 9, 16, VIDEO_AREA),
  shape('Square', 1, 1, VIDEO_AREA),
  shape('Landscape', 4, 3, VIDEO_AREA),
  shape('Portrait', 3, 4, VIDEO_AREA),
  shape('Cinema', 21, 9, VIDEO_AREA),
]

/** A side the person typed, in whole pixels, or null when it is not a number. */
export function parseSide(text: string): number | null {
  const trimmed = text.trim()
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : null
}

/** A side snapped to a multiple of 16 and kept inside what the model accepts. */
export function snapSide(value: number, min: number, max: number): number {
  const snapped = Math.round(value / 16) * 16
  const lowest = Math.ceil(min / 16) * 16
  const highest = Math.floor(max / 16) * 16
  return Math.min(highest, Math.max(lowest, snapped))
}

/**
 * The size for the two boxes of a custom resolution. Anything that is not a
 * number falls back to `fallback`, so a half-typed box never starts a run at a
 * size nobody chose.
 */
export function customSize(
  widthText: string,
  heightText: string,
  limits: { min: number; max: number },
  fallback: number
): { width: number; height: number } {
  const side = (text: string) => snapSide(parseSide(text) ?? fallback, limits.min, limits.max)
  return { width: side(widthText), height: side(heightText) }
}

/**
 * The shape on the list closest to a size: an exact match when there is one,
 * else the nearest proportions, so a picture made with an older size list still
 * remixes at about the shape it had.
 */
export function sizeIndexOf(sizes: StudioSize[], width: number, height: number): number {
  const exact = sizes.findIndex((s) => s.width === width && s.height === height)
  if (exact !== -1) return exact
  const target = Math.log(width / height)
  let best = 0
  sizes.forEach((s, i) => {
    if (Math.abs(Math.log(s.width / s.height) - target) < Math.abs(Math.log(sizes[best].width / sizes[best].height) - target)) best = i
  })
  return best
}

/** Prompts to try, shown while the box is empty. */
export const EXAMPLE_PROMPTS: Record<'image' | 'video', string[]> = {
  image: ['A lighthouse on a cliff at sunrise, oil painting', 'A fox in a snowy forest, soft light', 'Isometric city at night, neon'],
  video: ['A cat walking through a rainy alley, cinematic', 'Waves rolling onto a black beach', 'Steam rising from a coffee cup'],
}

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

type Workload = { width: number; height: number; frames: number | null; steps: number }

/**
 * About how long a clip will take, scaled from one the person already made on
 * this computer: time grows with pixels, frames and steps. Null when there is
 * nothing to scale from, because a guess with no basis is worse than none.
 */
export function estimateVideoMs(
  previous: (Workload & { durationMs: number }) | undefined,
  next: Workload
): number | null {
  if (!previous || previous.durationMs <= 0) return null
  const work = (w: Workload) => w.width * w.height * Math.max(1, w.frames ?? 1) * Math.max(1, w.steps)
  const ratio = work(next) / work(previous)
  return Number.isFinite(ratio) && ratio > 0 ? Math.round(previous.durationMs * ratio) : null
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
