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

/**
 * Markers of an engine process that crashed inside the GPU driver: an access
 * violation or segfault, or the driver reporting a lost or reset device. A
 * buggy Vulkan or CUDA driver can take the worker down this way while the
 * model's weights are being uploaded (janhq/jan#8567).
 */
const GPU_CRASH_MARKERS = [
  'access violation',
  '0xc0000005',
  'sigsegv',
  'segmentation fault',
  'sigbus',
  'bus error',
  'device lost',
  'devicelost',
  'error_device_lost',
  'driver reset',
  'tdr',
  'device was removed',
  'dxgi_error_device_removed',
  'cuda_error_launch_failed',
  'cudaerrorlaunchfailure',
  'kiogpucommandbuffercallbackerrorhang',
]

/**
 * Whether a failed load looks like the GPU driver crashing the engine, so
 * loading the model on the CPU could work. Only called for a failure of the
 * load itself: a crash after a successful load (mid-generation) never reaches
 * here and is reported as it is. Not offered when the engine already runs on
 * the CPU only, or when this model was already moved to the CPU.
 */
export function isGpuCrashDuringLoad(args: {
  error: unknown
  alreadyOnCpu: boolean
  configuredDevice?: unknown
}): boolean {
  if (args.alreadyOnCpu) return false
  const device =
    typeof args.configuredDevice === 'string'
      ? args.configuredDevice.trim().toLowerCase()
      : ''
  if (device === 'none') return false
  const e = args.error as
    | { code?: unknown; details?: unknown; message?: unknown }
    | null
    | undefined
  if (!e || typeof e !== 'object') return false
  if (e.code !== 'ENGINE_STOPPED' && e.code !== 'MODEL_LOAD_FAILED') return false
  const text = [e.details, e.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
  return GPU_CRASH_MARKERS.some((m) =>
    m === 'tdr' ? /\btdr\b/.test(text) : text.includes(m)
  )
}
