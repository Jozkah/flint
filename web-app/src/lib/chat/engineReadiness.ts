import type { ServiceHub } from '@/services'

/**
 * Waits until a local model is loaded again after its engine went away.
 *
 * A crashed model can still be listed as loaded, so loading it alone would
 * no-op; `reloadModel` unloads it first and is shared per model, so the
 * reload customFetch already started for a crash is joined, not repeated.
 */

/** How long the wait may take; a cold load of a large model is slow. */
export const ENGINE_READY_TIMEOUT_MS = 120_000

export type EngineReadiness =
  | { ok: true }
  | {
      ok: false
      reason: 'aborted' | 'timeout' | 'no_provider' | 'reload_failed'
      error?: string
    }

export async function waitForEngineReady(args: {
  provider: ProviderObject | undefined
  modelId: string
  serviceHub: Pick<ServiceHub, 'models'>
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<EngineReadiness> {
  const { provider, modelId, serviceHub, signal } = args
  if (!provider) return { ok: false, reason: 'no_provider' }
  if (signal?.aborted) return { ok: false, reason: 'aborted' }
  const timeoutMs = args.timeoutMs ?? ENGINE_READY_TIMEOUT_MS

  return new Promise<EngineReadiness>((resolve) => {
    let settled = false
    const settle = (result: EngineReadiness) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => settle({ ok: false, reason: 'aborted' })
    const timer = setTimeout(
      () => settle({ ok: false, reason: 'timeout' }),
      timeoutMs
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    serviceHub
      .models()
      .reloadModel(provider, modelId)
      .then(
        () => settle({ ok: true }),
        (error: unknown) =>
          settle({
            ok: false,
            reason: 'reload_failed',
            error: error instanceof Error ? error.message : String(error),
          })
      )
  })
}
