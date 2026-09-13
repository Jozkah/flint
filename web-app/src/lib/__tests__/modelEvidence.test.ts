import { describe, it, expect } from 'vitest'
import type { HardwareData } from '@/hooks/useHardware'
import {
  conditionDifferences,
  deviceSignature,
  evidenceFor,
  settingsFromModel,
  type ModelTestResult,
  type TestConditions,
} from '../modelEvidence'

const hardware: HardwareData = {
  cpu: { arch: 'x86_64', core_count: 8, extensions: [], name: 'Ryzen', usage: 0 },
  gpus: [],
  os_type: 'windows',
  os_name: 'Windows 11',
  total_memory: 32768,
}

const conditions = (overrides: Partial<TestConditions> = {}): TestConditions => ({
  modelSizeBytes: 4_000_000_000,
  settings: { ctx_len: 8192, ngl: -1 },
  runtimeVersion: '0.7.6',
  device: deviceSignature(hardware),
  concurrentModels: [],
  ...overrides,
})

const result = (
  overrides: Partial<ModelTestResult> = {}
): ModelTestResult => ({
  id: Math.random().toString(36),
  provider: 'llamacpp',
  modelId: 'qwen3-8b',
  testedAt: 1000,
  outcome: 'success',
  workload: 'short-reply',
  conditions: conditions(),
  metrics: {},
  unloadedModels: [],
  ...overrides,
})

describe('settingsFromModel', () => {
  it('reads only the settings that affect loading', () => {
    expect(
      settingsFromModel({
        settings: {
          ctx_len: { controller_props: { value: 4096 } },
          ngl: { controller_props: { value: 20 } },
          temperature: { controller_props: { value: 0.7 } },
        },
      })
    ).toEqual({ ctx_len: 4096, ngl: 20 })
  })
})

describe('evidenceFor', () => {
  it('says not tested when there is no result', () => {
    expect(evidenceFor([], conditions()).state).toBe('not-tested')
  })

  it('reports success only under the conditions it was measured with', () => {
    expect(evidenceFor([result()], conditions()).state).toBe('ran-successfully')
  })

  it('ties a failure to its settings rather than to the model', () => {
    const failed = result({
      outcome: 'failure',
      testedAt: 2000,
      error: { code: 'OUT_OF_MEMORY', message: 'oom' },
      conditions: conditions({ settings: { ctx_len: 32768, ngl: -1 } }),
    })
    const worked = result({ testedAt: 1000 })

    const atFailedSettings = evidenceFor(
      [failed, worked],
      conditions({ settings: { ctx_len: 32768, ngl: -1 } })
    )
    expect(atFailedSettings.state).toBe('failed-with-settings')
    expect(atFailedSettings.otherSuccess?.id).toBe(worked.id)

    // Back at the settings that worked, the old failure does not apply.
    expect(evidenceFor([failed, worked], conditions()).state).toBe('ran-successfully')
  })

  it('lets a retry with adjusted settings supersede a failure', () => {
    const failed = result({ outcome: 'failure', testedAt: 1000, error: { message: 'x' } })
    const retried = result({ outcome: 'success', testedAt: 2000 })
    expect(evidenceFor([failed, retried], conditions()).state).toBe('ran-successfully')
  })

  it('marks results stale when settings, device, runtime or file change', () => {
    const base = [result()]
    const settings = evidenceFor(base, conditions({ settings: { ctx_len: 16384, ngl: -1 } }))
    expect(settings.state).toBe('stale')
    expect(settings.differences).toEqual([{ kind: 'settings', keys: ['ctx_len'] }])

    const device = evidenceFor(
      base,
      conditions({ device: deviceSignature({ ...hardware, total_memory: 16384 }) })
    )
    expect(device.differences).toEqual([{ kind: 'device' }])

    const runtime = evidenceFor(base, conditions({ runtimeVersion: '0.8.0' }))
    expect(runtime.differences).toEqual([
      { kind: 'runtime', recorded: '0.7.6', current: '0.8.0' },
    ])

    const file = evidenceFor(base, conditions({ modelSizeBytes: 5 }))
    expect(file.differences).toEqual([{ kind: 'model-file' }])
  })

  it('does not treat other loaded models as a changed condition', () => {
    const recorded = conditions({ concurrentModels: ['other'] })
    expect(conditionDifferences(recorded, conditions())).toEqual([])
  })

  it('reports an architecture refusal as unsupported by this runtime', () => {
    const refused = result({
      outcome: 'failure',
      error: { code: 'MODEL_ARCH_NOT_SUPPORTED', message: 'unknown arch' },
    })
    expect(evidenceFor([refused], conditions()).state).toBe('unsupported')
  })
})
