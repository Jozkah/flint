/** Helpers for the voice pill: the waveform history, the clock and a stand-in level. */

export const WAVE_EVERY = 4
export const WAVE_MAX = 80
export const HOLD_AFTER_MS = 300
export const CANCEL_DISTANCE = 64
export const SLIDE_MIN = 4

const LOOP = 4.8
const SYLLABLES: ReadonlyArray<readonly [number, number, number]> = [
  [0.1, 0.16, 0.9],
  [0.3, 0.12, 0.7],
  [0.5, 0.2, 1],
  [0.95, 0.14, 0.8],
  [1.15, 0.1, 0.6],
  [1.3, 0.22, 0.95],
  [1.9, 0.16, 0.85],
  [2.12, 0.12, 0.7],
  [2.3, 0.18, 0.9],
  [2.55, 0.1, 0.5],
  [3.05, 0.24, 1],
  [3.4, 0.12, 0.75],
  [3.6, 0.16, 0.9],
]

/** A looping speech-like level (0..1) for when no microphone level is available. */
export function simulatedLevel(seconds: number): number {
  const u = seconds % LOOP
  let a = 0.06
  for (const [start, length, peak] of SYLLABLES) {
    const x = (u - start) / length
    if (x >= 0 && x <= 1) {
      a = Math.max(a, peak * 0.5 * (1 - Math.cos(2 * Math.PI * x)))
    }
  }
  return a * (0.7 + 0.3 * Math.abs(Math.sin(2 * Math.PI * 7.1 * u)))
}

/** The recorder reports a raw peak; speech sits low, so lift it for display. */
export function displayLevel(raw: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, raw)) * 1.1)
}

/** m:ss */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** One-pole smoothing with a fast attack and a slow release. */
export function smoothLevel(
  env: number,
  target: number,
  dtSeconds: number
): number {
  const tau = (target > env ? 40 : 240) / 1000
  return env + (target - env) * (1 - Math.exp(-dtSeconds / tau))
}

export interface WaveState {
  hist: number[]
  tick: number
  acc: number
}

/** Fold one frame's level into the bar history; returns the sub-bar scroll fraction. */
export function pushWave(state: WaveState, level: number): number {
  state.acc = Math.max(state.acc, level)
  state.tick = (state.tick + 1) % WAVE_EVERY
  if (state.tick === 0) {
    state.hist.push(state.acc)
    state.acc = 0
    if (state.hist.length > WAVE_MAX) state.hist.shift()
  }
  return state.tick / WAVE_EVERY
}

/** Paint the bars: newest at the right edge, fading out toward the left. */
export function paintWave(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  hist: readonly number[],
  scroll: number,
  color: string
): void {
  const barW = 2 * dpr
  const step = 3 * dpr
  const shift = scroll * step
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = color
  for (let i = 0; i < hist.length; i++) {
    const v = hist[hist.length - 1 - i]
    const x = width - (i + 1) * step - shift
    if (x + barW < 0) break
    const h = Math.max(barW, (0.1 + 0.9 * v) * height)
    const t = Math.min(1, Math.max(0, (x + barW / 2) / (width * 0.55)))
    const fade = t * t * (3 - 2 * t)
    ctx.globalAlpha = (0.35 + 0.65 * v) * fade
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, (height - h) / 2, barW, h, barW / 2)
    } else {
      ctx.rect(x, (height - h) / 2, barW, h)
    }
    ctx.fill()
  }
  ctx.globalAlpha = 1
}
