/** Context window sizes the Default context size stepper moves between. */
export const CONTEXT_SIZE_STEPS = [4096, 8192, 16384, 32768, 65536, 131072]
export const CONTEXT_SIZE_MIN = 512

/**
 * The value the +/- button moves to. With `steps`, an empty value (Auto)
 * starts at the first step and each press moves to the next listed value
 * (past the last, by the last gap); otherwise by `step` from `min`.
 */
export function steppedValue(
  value: number | null,
  dir: 1 | -1,
  { min, max, step = 1, steps }: { min?: number; max?: number; step?: number; steps?: number[] }
): number {
  let next: number
  if (steps && steps.length > 0) {
    if (value === null) next = steps[0]
    else if (dir > 0) {
      const gap = steps.length > 1 ? steps[steps.length - 1] - steps[steps.length - 2] : steps[0]
      next = steps.find((s) => s > value) ?? value + gap
    } else {
      next = [...steps].reverse().find((s) => s < value) ?? value
    }
  } else {
    const decimals = (step.toString().split('.')[1] || '').length
    next = Number(((value ?? min ?? 0) + dir * step).toFixed(decimals))
  }
  if (min !== undefined && next < min) next = min
  if (max !== undefined && next > max) next = max
  return next
}
