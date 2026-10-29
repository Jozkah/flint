/* eslint-disable @typescript-eslint/no-explicit-any */

// Remote lists longer than this get a filter box; rows render this many at a time.
export const MODEL_FILTER_MIN = 20

/** The last path segment, on either separator. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A model's configured context length, when it has one. */
export function contextLengthOf(model: Model): number | undefined {
  const value = (model.settings as any)?.ctx_len?.controller_props?.value
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** How many recent replies the speed chart shows. */
export const SPEED_WINDOW = 24

/** The engine settings a user reaches for first: open by default. */
export const ENGINE_BASIC_KEYS = new Set([
  'ctx_size',
  'fit',
  'fit_target',
  'models_max',
  'idle_unload_minutes',
  'timeout',
  'threads',
  'threads_batch',
])

export type DetailTab = 'models' | 'connection' | 'engine'

export const CHIP_TONE = {
  success: 'ok',
  warning: 'warn',
  destructive: 'err',
  neutral: 'neutral',
  progress: 'neutral',
} as const
