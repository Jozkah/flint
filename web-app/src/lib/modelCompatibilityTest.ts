import { parseEngineError } from '@/lib/engineError'
import type { TestMetrics } from '@/lib/modelEvidence'

/**
 * A real, opt-in compatibility test for one installed local model.
 *
 * It loads the model with the settings it already has, sends one short chat
 * request to the running engine, reports only what the engine reported, and
 * releases what it loaded. It never downloads anything, never tests more than
 * the one model the user asked about, and never unloads another model unless
 * the user named that model in `allowUnload` after being told.
 */

export interface CompatibilityTestDeps {
  getActiveModels: () => Promise<string[]>
  /** Loads `modelId` with its configured settings. */
  startModel: (modelId: string) => Promise<unknown>
  stopModel: (modelId: string) => Promise<unknown>
  findSession: (
    modelId: string
  ) => Promise<{ port: number; api_key: string } | null>
  fetch: typeof globalThis.fetch
  now: () => number
  /**
   * True when nothing is generating on the model. Checked before a test would
   * unload another model, so a reply in progress is never cut off.
   */
  isModelIdle?: (modelId: string) => Promise<boolean>
}

export interface CompatibilityTestRequest {
  modelId: string
  /** The engine's `models_max`: 0 means unlimited. */
  modelsMax: number
  /** Models the user explicitly agreed may be unloaded for this test. */
  allowUnload: string[]
  signal: AbortSignal
}

export interface CompatibilityTestPlan {
  alreadyLoaded: boolean
  /** Models the engine would unload to stay within `models_max`. */
  willUnload: string[]
  /** Other models that stay loaded during the test. */
  staysLoaded: string[]
}

/** What happened to models the test had to unload, once it finished. */
export interface RestoreReport {
  /** Reloaded after the test released its model. */
  restored: string[]
  /** Could not be reloaded; the user has to load them again. */
  notRestored: string[]
}

export type CompatibilityTestOutcome =
  | { kind: 'needs-confirmation'; plan: CompatibilityTestPlan }
  /** Nothing was loaded or unloaded. */
  | {
      kind: 'blocked'
      reason: 'model-busy' | 'test-in-progress'
      models: string[]
    }
  | ({ kind: 'cancelled'; released: boolean } & RestoreReport)
  | ({
      kind: 'completed'
      outcome: 'success' | 'failure'
      metrics: TestMetrics
      error?: { code?: string; message: string }
      unloadedModels: string[]
      concurrentModels: string[]
      /** False when the test loaded the model and could not unload it. */
      released: boolean
    } & RestoreReport)

export const TEST_PROMPT = 'Reply with the single word: ready'
export const TEST_MAX_TOKENS = 16

export function planCompatibilityTest(
  activeModels: string[],
  modelId: string,
  modelsMax: number
): CompatibilityTestPlan {
  const others = activeModels.filter((m) => m !== modelId)
  if (activeModels.includes(modelId)) {
    return { alreadyLoaded: true, willUnload: [], staysLoaded: others }
  }
  if (modelsMax <= 0 || others.length < modelsMax) {
    return { alreadyLoaded: false, willUnload: [], staysLoaded: others }
  }
  // The engine evicts the oldest loaded chat model, an order the renderer
  // cannot see, so every model that could be chosen is named up front.
  return { alreadyLoaded: false, willUnload: others, staysLoaded: [] }
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}

function describeFailure(error: unknown): { code?: string; message: string } {
  const engineError = parseEngineError(error)
  if (engineError) {
    return {
      code: engineError.code,
      message:
        engineError.message ?? engineError.details ?? engineError.code,
    }
  }
  if (error instanceof Error) return { message: error.message }
  return { message: typeof error === 'string' ? error : String(error) }
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Only fields the engine actually returned. */
export function metricsFromResponse(body: unknown): TestMetrics {
  const record = (body ?? {}) as {
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    timings?: { predicted_per_second?: unknown; prompt_per_second?: unknown }
  }
  const metrics: TestMetrics = {}
  const promptTokens = finiteNumber(record.usage?.prompt_tokens)
  const completionTokens = finiteNumber(record.usage?.completion_tokens)
  const generation = finiteNumber(record.timings?.predicted_per_second)
  const prompt = finiteNumber(record.timings?.prompt_per_second)
  if (promptTokens !== undefined) metrics.promptTokens = promptTokens
  if (completionTokens !== undefined) metrics.completionTokens = completionTokens
  if (generation !== undefined) metrics.generationTokensPerSecond = generation
  if (prompt !== undefined) metrics.promptTokensPerSecond = prompt
  return metrics
}

/** One test at a time: two would fight over the same memory and eviction. */
let testInFlight = false

/** For tests: forget a lock left by an earlier case. */
export function resetCompatibilityTestLock(): void {
  testInFlight = false
}

export async function runCompatibilityTest(
  request: CompatibilityTestRequest,
  deps: CompatibilityTestDeps
): Promise<CompatibilityTestOutcome> {
  if (request.signal.aborted) {
    return { kind: 'cancelled', released: true, restored: [], notRestored: [] }
  }
  if (testInFlight) {
    return { kind: 'blocked', reason: 'test-in-progress', models: [] }
  }
  testInFlight = true
  try {
    return await runLocked(request, deps)
  } finally {
    testInFlight = false
  }
}

async function runLocked(
  request: CompatibilityTestRequest,
  deps: CompatibilityTestDeps
): Promise<CompatibilityTestOutcome> {
  const { modelId, signal } = request

  const active = await deps.getActiveModels()
  const plan = planCompatibilityTest(active, modelId, request.modelsMax)
  const unapproved = plan.willUnload.filter(
    (m) => !request.allowUnload.includes(m)
  )
  if (unapproved.length > 0) return { kind: 'needs-confirmation', plan }

  // Consent to unload a model is not consent to cut off a reply it is
  // writing. Checked at the last moment before anything changes.
  if (plan.willUnload.length > 0 && deps.isModelIdle) {
    const busy: string[] = []
    for (const other of plan.willUnload) {
      const idle = await deps.isModelIdle(other).catch(() => false)
      if (!idle) busy.push(other)
    }
    if (busy.length > 0) {
      return { kind: 'blocked', reason: 'model-busy', models: busy }
    }
  }

  const metrics: TestMetrics = {}
  let loadedByTest = false
  let released = true

  /** Releases only what this test loaded. */
  const release = async (): Promise<boolean> => {
    if (!loadedByTest) return true
    try {
      await deps.stopModel(modelId)
      loadedByTest = false
      return true
    } catch {
      return false
    }
  }

  /**
   * Reloads the models the engine evicted for the test. Only after the test's
   * own model is gone: reloading first would evict it again or push the
   * engine over its limit.
   */
  const restore = async (): Promise<RestoreReport> => {
    const report: RestoreReport = { restored: [], notRestored: [] }
    if (plan.willUnload.length === 0) return report
    if (!released) {
      report.notRestored = [...plan.willUnload]
      return report
    }
    for (const other of plan.willUnload) {
      try {
        await deps.startModel(other)
        report.restored.push(other)
      } catch {
        report.notRestored.push(other)
      }
    }
    return report
  }

  const finish = async (): Promise<RestoreReport> => {
    released = await release()
    return restore()
  }

  const cancelled = async (): Promise<CompatibilityTestOutcome> => {
    const report = await finish()
    return { kind: 'cancelled', released, ...report }
  }

  const completed = async (
    outcome: 'success' | 'failure',
    error?: { code?: string; message: string }
  ): Promise<CompatibilityTestOutcome> => {
    const report = await finish()
    return {
      kind: 'completed',
      outcome,
      metrics,
      ...(error ? { error } : {}),
      unloadedModels: plan.willUnload,
      concurrentModels: plan.staysLoaded,
      released,
      ...report,
    }
  }

  // ---- Load ----------------------------------------------------------------
  if (!plan.alreadyLoaded) {
    const loadStart = deps.now()
    try {
      loadedByTest = true
      await deps.startModel(modelId)
    } catch (error) {
      // A failed load normally leaves nothing loaded; unloading anyway covers
      // an engine that reports failure after partially loading.
      if (isAbort(error, signal)) return cancelled()
      return completed('failure', describeFailure(error))
    }
    metrics.loadMs = deps.now() - loadStart
    // Loading cannot be interrupted; a cancel that arrived meanwhile is
    // honoured now by releasing what was loaded.
    if (signal.aborted) return cancelled()
  }

  // ---- Short representative request ---------------------------------------
  const session = await deps.findSession(modelId)
  if (!session) {
    return completed('failure', {
      message: 'The model loaded but no running session was found for it.',
    })
  }

  const requestStart = deps.now()
  try {
    const response = await deps.fetch(
      `http://localhost:${session.port}/v1/chat/completions`,
      {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.api_key}`,
          Origin: 'tauri://localhost',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: TEST_PROMPT }],
          max_tokens: TEST_MAX_TOKENS,
          temperature: 0,
          stream: false,
        }),
      }
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return completed('failure', {
        message: `The engine answered HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`,
      })
    }
    const body = await response.json()
    metrics.requestMs = deps.now() - requestStart
    Object.assign(metrics, metricsFromResponse(body))
    const choices = (body as { choices?: unknown[] })?.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      return completed('failure', {
        message: 'The engine answered without generating a reply.',
      })
    }
    return completed('success')
  } catch (error) {
    if (isAbort(error, signal)) return cancelled()
    return completed('failure', describeFailure(error))
  }
}
