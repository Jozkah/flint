/**
 * The one status a model row shows, derived from state the app already holds.
 *
 * Several surfaces talk about whether a model is running: the provider's model
 * list, the model picker, the status bar. Each used to decide on its own, so a
 * model could read "Start" in one place while another said it was loaded. This
 * names every status and the precedence between them in one pure function, so
 * any surface that uses it agrees with every other one.
 *
 * Engine-managed models (llama.cpp, MLX), highest precedence first:
 * - `loading`   a load started from the app has not settled
 * - `loaded`    the engine lists the model among its active models
 * - `failed`    the last load of this model threw and the error is still shown
 * - `available` installed and not loaded
 *
 * Remote models have no load step. Only what is actually known is claimed:
 * - `needs-api-key` the endpoint is remote and no key is saved
 * - `connected`     a request with a saved key has succeeded this session
 * - `null`          nothing is known either way; no status is shown
 *
 * Nothing here gates anything. A status describes; it never disables a model.
 */
export type ModelStatus =
  | 'loading'
  | 'loaded'
  | 'failed'
  | 'available'
  | 'needs-api-key'
  | 'connected'

/** The semantic tone a status is drawn in. Never derived from the accent. */
export type ModelStatusTone = 'success' | 'warning' | 'destructive' | 'neutral' | 'progress'

export type ModelStatusInput = {
  modelId: string
  /** Whether a local engine loads this model (llama.cpp, MLX). */
  engineManaged: boolean
  /** `useAppState.activeModels`: what the engine reports as loaded. */
  activeModels?: readonly string[]
  /** Model ids with a load in flight. */
  loadingModelIds?: readonly string[]
  /** Model ids whose last load failed and whose error has not been cleared. */
  failedModelIds?: readonly string[]
  /** Remote only: the endpoint is remote and no API key is saved. */
  apiKeyMissing?: boolean
  /** Remote only: a request with a saved key succeeded this session. */
  connectionVerified?: boolean
}

export function deriveModelStatus(input: ModelStatusInput): ModelStatus | null {
  const { modelId } = input
  if (input.engineManaged) {
    if (input.loadingModelIds?.includes(modelId)) return 'loading'
    if (input.activeModels?.includes(modelId)) return 'loaded'
    if (input.failedModelIds?.includes(modelId)) return 'failed'
    return 'available'
  }
  if (input.apiKeyMissing) return 'needs-api-key'
  if (input.connectionVerified) return 'connected'
  return null
}

const TONES: Record<ModelStatus, ModelStatusTone> = {
  loading: 'progress',
  loaded: 'success',
  failed: 'destructive',
  available: 'neutral',
  'needs-api-key': 'warning',
  connected: 'success',
}

export function modelStatusTone(status: ModelStatus): ModelStatusTone {
  return TONES[status]
}

/**
 * The `providers:` locale key for a status label. Literal keys, so a scan of
 * the source finds every one of them.
 */
export function modelStatusLabelKey(status: ModelStatus): string {
  switch (status) {
    case 'loading':
      return 'providers:status.loading'
    case 'loaded':
      return 'providers:status.loaded'
    case 'failed':
      return 'providers:status.failed'
    case 'available':
      return 'providers:status.available'
    case 'needs-api-key':
      return 'providers:status.needsApiKey'
    case 'connected':
      return 'providers:status.connected'
  }
}
