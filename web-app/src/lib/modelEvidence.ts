import type { HardwareData } from '@/hooks/useHardware'

/**
 * Measured evidence about a model on this device, and when it stops applying.
 *
 * A test result proves exactly one thing: this model file, with these settings,
 * on this runtime and this hardware, completed (or failed) one short task. It
 * says nothing about a longer context, a heavier prompt, or other models loaded
 * at the same time, so a result is tied to the conditions it was measured
 * under and is reported as stale the moment any of them change. A failure is
 * likewise a failure *of those settings*, never a verdict on the model.
 */

/** Settings that change what loading a model costs or whether it loads. */
export const TEST_SETTING_KEYS = [
  'ctx_len',
  'ngl',
  'cache_type_k',
  'cache_type_v',
  'flash_attn',
  'n_cpu_moe',
  'offload_mmproj',
] as const

export type TestSettingKey = (typeof TEST_SETTING_KEYS)[number]
export type TestSettings = Partial<
  Record<TestSettingKey, string | number | boolean>
>

export interface DeviceSignature {
  os: string
  cpu: string
  totalMemoryMib: number
  gpus: { name: string; totalMemoryMib: number; driver: string }[]
}

export interface TestConditions {
  /** File size of the model at test time; a changed file is a changed model. */
  modelSizeBytes: number | null
  settings: TestSettings
  /** The engine ships inside the app, so the app version identifies it. */
  runtimeVersion: string
  device: DeviceSignature
  /** Other models loaded while the test ran. Informational, not a staleness key. */
  concurrentModels: string[]
}

/** Only metrics the runtime actually reported; absent means not reported. */
export interface TestMetrics {
  loadMs?: number
  requestMs?: number
  promptTokens?: number
  completionTokens?: number
  generationTokensPerSecond?: number
  promptTokensPerSecond?: number
}

export type TestWorkload = 'short-reply'

export interface ModelTestResult {
  id: string
  provider: string
  modelId: string
  testedAt: number
  outcome: 'success' | 'failure'
  workload: TestWorkload
  conditions: TestConditions
  metrics: TestMetrics
  error?: { code?: string; message: string }
  /** Models the user agreed to unload so the test could run. */
  unloadedModels: string[]
}

type SettingsBag = Record<
  string,
  { controller_props?: { value?: unknown } } | undefined
>

export function settingsFromModel(
  model: { settings?: SettingsBag | Record<string, unknown> } | undefined
): TestSettings {
  const out: TestSettings = {}
  const settings = (model?.settings ?? {}) as SettingsBag
  for (const key of TEST_SETTING_KEYS) {
    const value = settings[key]?.controller_props?.value
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value
    }
  }
  return out
}

export function deviceSignature(hardware: HardwareData): DeviceSignature {
  return {
    os: [hardware.os_type, hardware.os_name].filter(Boolean).join(' '),
    cpu: hardware.cpu?.name ?? '',
    totalMemoryMib: hardware.total_memory || 0,
    gpus: (hardware.gpus ?? [])
      .map((g) => ({
        name: g.name,
        totalMemoryMib: g.total_memory || 0,
        driver: g.driver_version ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export type ConditionDifference =
  | { kind: 'settings'; keys: TestSettingKey[] }
  | { kind: 'device' }
  | { kind: 'runtime'; recorded: string; current: string }
  | { kind: 'model-file' }

export function conditionDifferences(
  recorded: TestConditions,
  current: Omit<TestConditions, 'concurrentModels'>
): ConditionDifference[] {
  const diffs: ConditionDifference[] = []

  const keys = TEST_SETTING_KEYS.filter(
    (key) => recorded.settings[key] !== current.settings[key]
  )
  if (keys.length > 0) diffs.push({ kind: 'settings', keys })

  if (JSON.stringify(recorded.device) !== JSON.stringify(current.device)) {
    diffs.push({ kind: 'device' })
  }
  if (recorded.runtimeVersion !== current.runtimeVersion) {
    diffs.push({
      kind: 'runtime',
      recorded: recorded.runtimeVersion,
      current: current.runtimeVersion,
    })
  }
  if (
    recorded.modelSizeBytes != null &&
    current.modelSizeBytes != null &&
    recorded.modelSizeBytes !== current.modelSizeBytes
  ) {
    diffs.push({ kind: 'model-file' })
  }
  return diffs
}

export type EvidenceState =
  /** Latest result under the current conditions succeeded. */
  | 'ran-successfully'
  /** Latest result under the current conditions failed. */
  | 'failed-with-settings'
  /** The runtime refused the model itself (architecture), on this runtime. */
  | 'unsupported'
  /** Only results under different conditions exist. */
  | 'stale'
  | 'not-tested'

export interface ModelEvidence {
  state: EvidenceState
  /** The result the state is based on. */
  latest?: ModelTestResult
  /** Why `latest` does not apply, when the state is `stale`. */
  differences: ConditionDifference[]
  /** A success under other settings, worth mentioning next to a failure. */
  otherSuccess?: ModelTestResult
}

/** Engine error codes that are about the model and runtime, not settings. */
const RUNTIME_REFUSAL_CODES = new Set(['MODEL_ARCH_NOT_SUPPORTED'])

export function evidenceFor(
  results: ModelTestResult[] | undefined,
  current: Omit<TestConditions, 'concurrentModels'>
): ModelEvidence {
  const sorted = [...(results ?? [])].sort((a, b) => b.testedAt - a.testedAt)
  if (sorted.length === 0) return { state: 'not-tested', differences: [] }

  const matching = sorted.find(
    (r) => conditionDifferences(r.conditions, current).length === 0
  )

  if (matching) {
    if (matching.outcome === 'success') {
      return { state: 'ran-successfully', latest: matching, differences: [] }
    }
    const otherSuccess = sorted.find((r) => r.outcome === 'success')
    const refusedByRuntime =
      matching.error?.code != null &&
      RUNTIME_REFUSAL_CODES.has(matching.error.code)
    return {
      state: refusedByRuntime ? 'unsupported' : 'failed-with-settings',
      latest: matching,
      differences: [],
      otherSuccess,
    }
  }

  const latest = sorted[0]
  return {
    state: 'stale',
    latest,
    differences: conditionDifferences(latest.conditions, current),
    otherSuccess: sorted.find((r) => r.outcome === 'success'),
  }
}

export const MAX_RESULTS_PER_MODEL = 10

export function resultKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`
}
