import { create } from 'zustand'

/** Settings > Appearance > Performance mode. */
export type PerformanceMode = 'auto' | 'reduced' | 'full'

export const PERFORMANCE_MODES: readonly PerformanceMode[] = ['auto', 'reduced', 'full']

export function isPerformanceMode(v: unknown): v is PerformanceMode {
  return v === 'auto' || v === 'reduced' || v === 'full'
}

/** Why Auto picked the reduced mode (the first reason that applies). */
export type PerfReason = 'cores' | 'memory' | 'frames' | 'motion' | 'data'

export type PerfDetection = {
  reduced: boolean
  reason?: PerfReason
  cores?: number
  memoryGb?: number
  /** Median frame time of the probe, once it has run. */
  frameMs?: number
}

/** Cores / GB at or below which Auto reduces. */
export const LOW_CORES = 4
export const LOW_MEMORY_GB = 4
/** A median frame slower than this during the probe means a struggling GPU/CPU. */
export const SLOW_FRAME_MS = 24

type EnvLike = {
  hardwareConcurrency?: number
  deviceMemory?: number
  saveData?: boolean
  prefersReducedMotion?: boolean
}

function readEnv(): EnvLike {
  if (typeof navigator === 'undefined') return {}
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { saveData?: boolean }
  }
  return {
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    saveData: nav.connection?.saveData,
    prefersReducedMotion:
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

/** What Auto decides from the device alone, before the frame probe. */
export function detectFromEnv(env: EnvLike = readEnv(), frameMs?: number): PerfDetection {
  const cores = env.hardwareConcurrency || undefined
  const memoryGb = env.deviceMemory || undefined
  const base = { cores, memoryGb, frameMs }
  if (cores !== undefined && cores <= LOW_CORES) return { ...base, reduced: true, reason: 'cores' }
  if (memoryGb !== undefined && memoryGb <= LOW_MEMORY_GB)
    return { ...base, reduced: true, reason: 'memory' }
  if (frameMs !== undefined && frameMs > SLOW_FRAME_MS)
    return { ...base, reduced: true, reason: 'frames' }
  if (env.prefersReducedMotion) return { ...base, reduced: true, reason: 'motion' }
  if (env.saveData) return { ...base, reduced: true, reason: 'data' }
  return { ...base, reduced: false }
}

/** Median of frame intervals measured with requestAnimationFrame for `ms`. */
export function probeFrames(ms = 1000): Promise<number | undefined> {
  if (typeof requestAnimationFrame === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const gaps: number[] = []
    let last: number | undefined
    let startAt: number | undefined
    const step = (t: number) => {
      if (startAt === undefined) startAt = t
      if (last !== undefined) gaps.push(t - last)
      last = t
      if (t - startAt < ms) requestAnimationFrame(step)
      else {
        gaps.sort((a, b) => a - b)
        resolve(gaps.length ? gaps[Math.floor(gaps.length / 2)] : undefined)
      }
    }
    requestAnimationFrame(step)
  })
}

export const usePerfDetection = create<{ detection: PerfDetection }>(() => ({
  detection: detectFromEnv(),
}))

/** Whether the reduced styles and slower streaming apply right now. */
export function resolvePerfReduced(mode: PerformanceMode, detection: PerfDetection): boolean {
  return mode === 'reduced' || (mode === 'auto' && detection.reduced)
}

let probed = false

/**
 * Runs the one-second frame probe once, a few seconds after start-up (boot
 * work would make any machine look slow), and only while the window is shown
 * (hidden windows get no frames).
 */
export function scheduleFrameProbe(delayMs = 5000): void {
  if (probed || typeof window === 'undefined') return
  probed = true
  const run = () => {
    if (document.visibilityState === 'hidden') {
      document.addEventListener('visibilitychange', run, { once: true })
      return
    }
    void probeFrames().then((frameMs) => {
      if (frameMs === undefined) return
      usePerfDetection.setState({ detection: detectFromEnv(readEnv(), frameMs) })
    })
  }
  setTimeout(run, delayMs)
}

/** Streaming UI updates are coalesced to one per this many ms. */
export function streamingThrottleMs(reduced: boolean): number {
  return reduced ? 100 : 50
}
