import { create } from 'zustand'

/**
 * The question asked when the GPU driver crashed the engine while a model was
 * loading: load it on the CPU instead? The llama.cpp extension marks such a
 * failure with `cpu_fallback_offered`; a crash after a successful load
 * (mid-generation) never carries the mark and is reported as before.
 *
 * Asked at most once per model per app run, through the app's own dialog
 * (`GpuCrashCpuFallbackDialog`, mounted once at the root).
 */
const asked = new Set<string>()

type Request = { modelId: string; resolve: (ok: boolean) => void }

export const useGpuCrashCpuFallback = create<{ request: Request | null }>(
  () => ({ request: null })
)

/** True when `error` is a load the GPU driver crashed and the CPU may run. */
export function isCpuFallbackOffered(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { cpu_fallback_offered?: unknown }).cpu_fallback_offered === true
  )
}

/** Settle the open question, if any. */
export function answerGpuCrashCpuFallback(ok: boolean): void {
  const request = useGpuCrashCpuFallback.getState().request
  if (!request) return
  useGpuCrashCpuFallback.setState({ request: null })
  request.resolve(ok)
}

/** Asks whether to load `modelId` on the CPU; false when already asked this run. */
export function askCpuFallback(modelId: string): Promise<boolean> {
  if (asked.has(modelId)) return Promise.resolve(false)
  asked.add(modelId)
  answerGpuCrashCpuFallback(false)
  return new Promise<boolean>((resolve) => {
    useGpuCrashCpuFallback.setState({ request: { modelId, resolve } })
  })
}

/** Test seam: forget what was asked. */
export function resetGpuCrashCpuFallback(): void {
  asked.clear()
  useGpuCrashCpuFallback.setState({ request: null })
}
