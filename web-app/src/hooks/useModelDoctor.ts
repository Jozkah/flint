import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  modelFingerprint,
  runModelProbe,
  settingsSummary,
  type ProbeDeps,
  type ProbeResult,
} from '@/lib/modelDoctor'

/**
 * Model Doctor results, one per model, each tied to the fingerprint of the
 * settings it was observed under. A result whose fingerprint no longer
 * matches the model's current settings is not shown as the model's status:
 * it describes a configuration that no longer exists.
 */
export const doctorKey = (provider: string, modelId: string) => `${provider}:${modelId}`

type ModelDoctorState = {
  results: Record<string, ProbeResult>
  /** Probes in flight, by key. Not persisted. */
  running: Record<string, AbortController>
  test: (
    provider: ProviderObject,
    model: Model,
    createModel: ProbeDeps['createModel'],
    extra?: Omit<ProbeDeps, 'createModel'>
  ) => Promise<ProbeResult>
  cancel: (provider: string, modelId: string) => void
  clear: (provider: string, modelId: string) => void
}

export const useModelDoctor = create<ModelDoctorState>()(
  persist(
    (set, get) => ({
      results: {},
      running: {},
      test: async (provider, model, createModel, extra) => {
        const key = doctorKey(provider.provider, model.id)
        get().running[key]?.abort()
        const ctrl = new AbortController()
        set((s) => ({ running: { ...s.running, [key]: ctrl } }))
        try {
          const result = await runModelProbe(
            {
              provider: provider.provider,
              modelId: model.id,
              fingerprint: modelFingerprint(provider, model),
              settingsSummary: settingsSummary(provider, model),
            },
            { ...extra, createModel },
            ctrl.signal
          )
          // A cancelled probe observed nothing worth keeping.
          if (result.outcome !== 'cancelled') {
            set((s) => ({ results: { ...s.results, [key]: result } }))
          }
          return result
        } finally {
          set((s) => {
            if (s.running[key] !== ctrl) return s
            const running = { ...s.running }
            delete running[key]
            return { running }
          })
        }
      },
      cancel: (provider, modelId) => get().running[doctorKey(provider, modelId)]?.abort(),
      clear: (provider, modelId) =>
        set((s) => {
          const results = { ...s.results }
          delete results[doctorKey(provider, modelId)]
          return { results }
        }),
    }),
    {
      name: localStorageKey.modelDoctor,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) => ({ results: s.results }) as unknown as ModelDoctorState,
    }
  )
)

/**
 * The result for `model` under its current settings, or null. A result
 * recorded under other settings (or by an older probe) is reported as
 * `stale`, never as the model's status.
 */
export function currentDoctorResult(
  results: Record<string, ProbeResult>,
  provider: ProviderObject | undefined,
  model: Model | undefined
): { result: ProbeResult; stale: boolean } | null {
  if (!provider || !model) return null
  const result = results[doctorKey(provider.provider, model.id)]
  if (!result) return null
  return { result, stale: result.fingerprint !== modelFingerprint(provider, model) }
}

/** A current (not stale) result as the environment readiness row's fact. */
export function observedToolsFact(
  current: { result: ProbeResult; stale: boolean } | null
): { outcome: 'passed' | 'failed'; testedAt: string; detail?: string } | null {
  if (!current || current.stale) return null
  const { result } = current
  if (result.outcome === 'cancelled') return null
  const failed = result.checks.find((c) => c.ok === false)
  return {
    outcome: result.outcome,
    testedAt: new Date(result.testedAt).toLocaleString(),
    ...(failed ? { detail: failed.detail } : {}),
  }
}
