/**
 * Whether a failed load should be retried once with the model kept off the GPU.
 *
 * The engine's classified `CPU_NOT_SUPPORTED` (SIGILL / STATUS_ILLEGAL_INSTRUCTION)
 * most often comes from a GPU backend or a build path that needs an instruction
 * the CPU lacks. The CPU backend itself picks a variant the CPU can run, so
 * `device = none` frequently gets such a machine working, only slower. A
 * machine already set to CPU-only, or one that was already retried, is not
 * retried: nothing different would happen.
 */
export function shouldRetryLoadOnCpu(args: {
  error: unknown
  alreadyRetried: boolean
  /** The saved `device` setting; `none` means the user already chose CPU only. */
  configuredDevice?: unknown
}): boolean {
  if (args.alreadyRetried) return false
  const device =
    typeof args.configuredDevice === 'string'
      ? args.configuredDevice.trim().toLowerCase()
      : ''
  if (device === 'none') return false
  const e = args.error as { code?: unknown } | null | undefined
  return !!e && typeof e === 'object' && e.code === 'CPU_NOT_SUPPORTED'
}
