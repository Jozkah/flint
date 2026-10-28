/**
 * Setup readiness checks. Pure decision logic, kept out of the extension class
 * so it is testable without a router, a backend install, or Tauri.
 */

export type ReadinessStatus = 'ok' | 'warning'

/**
 * `runtimeUnreachable` means a GPU exists but the engine cannot see it, which
 * points at the driver or runtime. `missingLibrary` is the same symptom with the
 * cause established: the loader named a dependency it could not resolve.
 *
 * `noGpuHardware` is gone: it meant "a GPU build on a machine with no GPU",
 * which the bundled engine cannot be in -- no GPU means no GPU expected, which
 * is simply `ok`.
 */
export type GpuOffloadReason = 'runtimeUnreachable' | 'missingLibrary'

export interface GpuOffloadCheck {
  status: ReadinessStatus
  gpuExpected: boolean
  engineDeviceCount: number
  reason?: GpuOffloadReason
  /** Set only for `missingLibrary`, to drive install advice. */
  missingLibraries?: string[]
}

export type EmbeddingVectorProblem =
  | 'missing'
  | 'empty'
  | 'nonFinite'
  | 'degenerate'

export interface EmbeddingVectorCheck {
  ok: boolean
  dimension: number
  problem?: EmbeddingVectorProblem
}

/**
 * The backend a device id came from, e.g. `Vulkan0` -> `vulkan`.
 *
 * Observed rather than declared: with the engine bundled at a pinned version
 * there is no backend *setting* to read, and the device the engine actually
 * enumerated is a stronger signal than a configured name ever was -- a
 * configured `cuda` told us nothing about whether CUDA loaded.
 */
export function backendFromDeviceIds(deviceIds: string[]): string {
  const backends = deviceIds
    .map((id) => id.trim().replace(/\d+$/, '').toLowerCase())
    .filter((b) => b !== '')
  // Host-only entries (BLAS, CPU) are not accelerators. macOS lists `BLAS`
  // before `MTL0`, and an OpenBLAS Linux build can do the same, so taking the
  // first id read a Metal or Vulkan build as CPU-only.
  return backends.find((b) => !HOST_ONLY_BACKENDS.has(b)) ?? backends[0] ?? ''
}

const HOST_ONLY_BACKENDS = new Set(['blas', 'cpu', 'accelerate'])

/**
 * A GPU present in hardware but absent from the engine's device list means
 * layers silently run on the host: llama.cpp's layer fit puts everything on the
 * CPU and the engine still reports healthy. Comparing the two counts is the
 * only signal that offload never happened.
 */
export function evaluateGpuOffload(input: {
  engineDeviceCount: number
  hardwareGpuCount: number
  /** Vendor-or-name text of each GPU the hardware plugin found. */
  hardwareGpus?: string[]
  /** Id and name of each device the engine enumerated. */
  engineDevices?: { id: string; name?: string }[]
}): GpuOffloadCheck {
  const { engineDeviceCount, hardwareGpuCount } = input
  // "Expected" is now a property of the machine, not of a chosen build: the
  // shipped engine offloads wherever it can.
  const gpuExpected = hardwareGpuCount > 0

  // Identity, not count: an NVIDIA card the engine never enumerated is not
  // covered by an iGPU that it did. NVIDIA only, since a second AMD or Intel
  // entry is routinely an iGPU the engine skips on purpose.
  const nvidiaMissing =
    input.hardwareGpus !== undefined &&
    input.engineDevices !== undefined &&
    engineDeviceCount > 0 &&
    input.hardwareGpus.some((gpu) => /nvidia|geforce|quadro|rtx/i.test(gpu)) &&
    !input.engineDevices.some(
      (device) => /^cuda/i.test(device.id) || /nvidia/i.test(device.name ?? '')
    )

  if (!gpuExpected || (engineDeviceCount > 0 && !nvidiaMissing)) {
    return { status: 'ok', gpuExpected, engineDeviceCount }
  }

  return {
    status: 'warning',
    gpuExpected,
    engineDeviceCount,
    reason: 'runtimeUnreachable',
  }
}

/**
 * Validates a probe embedding before anything is persisted. Mirrors the checks
 * the vector-db plugin applies at insert time, so a broken embedder surfaces
 * during setup instead of on the user's first attachment.
 */
export function evaluateEmbeddingVector(
  vector: unknown
): EmbeddingVectorCheck {
  if (!Array.isArray(vector)) {
    return { ok: false, dimension: 0, problem: 'missing' }
  }
  if (vector.length === 0) {
    return { ok: false, dimension: 0, problem: 'empty' }
  }

  const dimension = vector.length
  const hasInvalid = vector.some(
    (value) => typeof value !== 'number' || !Number.isFinite(value)
  )
  if (hasInvalid) {
    return { ok: false, dimension, problem: 'nonFinite' }
  }

  // Cosine similarity divides by the vector norm, so an all-zero embedding
  // makes every score NaN rather than merely inaccurate.
  if (vector.every((value) => value === 0)) {
    return { ok: false, dimension, problem: 'degenerate' }
  }

  return { ok: true, dimension }
}
