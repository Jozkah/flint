import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  engineSlotsIdle,
  findSessionByModel,
  readGgufMetadata,
} from '@janhq/tauri-plugin-llamacpp-api'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useHardware } from '@/hooks/useHardware'
import { useAppState } from '@/hooks/useAppState'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { providerFetch } from '@/lib/providerFetch'
import {
  assessModelFit,
  DEFAULT_CTX_LENGTH,
  kvArchitectureFromGguf,
  resolveFitKvSettings,
  settingValues,
  type KvArchitecture,
} from '@/lib/modelCompatibility'
import {
  deviceSignature,
  evidenceFor,
  resultKey,
  settingsFromModel,
} from '@/lib/modelEvidence'
import {
  runCompatibilityTest,
  type CompatibilityTestPlan,
} from '@/lib/modelCompatibilityTest'

export const runtimeVersion = (): string =>
  typeof VERSION !== 'undefined' ? VERSION : 'unknown'

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'confirm'; plan: CompatibilityTestPlan }

/**
 * What the fit estimate and the recorded evidence say about a local model
 * (F8x3-008): its size and path, its attention shape, the estimate under the
 * current settings, and the evidence that matches them.
 */
export function useModelFitData({
  modelId,
  provider,
  contextSize,
  providerObject,
  activeModels,
}: {
  modelId: string | undefined
  provider: string | undefined
  contextSize: number
  providerObject: ModelProvider | undefined
  activeModels: string[]
}) {
  const serviceHub = useServiceHub()
  const hardwareData = useHardware((s) => s.hardwareData)
  const results = useModelEvidence((s) =>
    provider && modelId ? s.results[resultKey(provider, modelId)] : undefined
  )
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const [modelPath, setModelPath] = useState<string | undefined>()
  const [architecture, setArchitecture] = useState<KvArchitecture | null>(null)
  const isLocalEngine = provider === 'llamacpp'

  useEffect(() => {
    if (!modelId || !isLocalEngine) {
      setSizes({})
      setModelPath(undefined)
      return
    }
    let cancelled = false
    serviceHub
      .models()
      .fetchModels()
      .then((infos) => {
        if (cancelled) return
        const next: Record<string, number> = {}
        for (const info of infos) {
          if (info.providerId === provider && info.sizeBytes) {
            next[info.id] = info.sizeBytes
          }
        }
        setSizes(next)
        setModelPath(
          infos.find((i) => i.id === modelId && i.providerId === provider)?.path
        )
      })
      .catch(() => {
        if (!cancelled) setSizes({})
      })
    return () => {
      cancelled = true
    }
  }, [modelId, provider, isLocalEngine, serviceHub])

  // The attention shape turns the KV estimate from a guess into arithmetic.
  useEffect(() => {
    if (!modelPath) {
      setArchitecture(null)
      return
    }
    let cancelled = false
    readGgufMetadata(modelPath)
      .then((meta) => {
        if (!cancelled) setArchitecture(kvArchitectureFromGguf(meta?.metadata))
      })
      .catch(() => {
        if (!cancelled) setArchitecture(null)
      })
    return () => {
      cancelled = true
    }
  }, [modelPath])

  const modelConfig = providerObject?.models.find((m) => m.id === modelId)
  const settings = useMemo(() => settingsFromModel(modelConfig), [modelConfig])
  const sizeBytes = modelId ? (sizes[modelId] ?? null) : null
  const otherLoadedBytes = activeModels
    .filter((id) => id !== modelId)
    .reduce((sum, id) => sum + (sizes[id] ?? 0), 0)

  const kvSettings = useMemo(
    () =>
      resolveFitKvSettings(
        settingValues(modelConfig?.settings as never),
        settingValues(providerObject?.settings as never)
      ),
    [modelConfig, providerObject]
  )

  const assessment = useMemo(
    () =>
      assessModelFit({
        weightsBytes: sizeBytes,
        ctxLength: contextSize || DEFAULT_CTX_LENGTH,
        hardware: hardwareData,
        architecture,
        cacheTypeK: kvSettings.cacheTypeK,
        cacheTypeV: kvSettings.cacheTypeV,
        noKvOffload: kvSettings.noKvOffload,
        gpuLayers: typeof settings.ngl === 'number' ? settings.ngl : undefined,
        otherLoadedBytes,
      }),
    [
      kvSettings,
      sizeBytes,
      contextSize,
      hardwareData,
      architecture,
      settings,
      otherLoadedBytes,
    ]
  )

  const currentConditions = useMemo(
    () => ({
      modelSizeBytes: sizeBytes,
      settings,
      runtimeVersion: runtimeVersion(),
      device: deviceSignature(hardwareData),
    }),
    [sizeBytes, settings, hardwareData]
  )
  const evidence = useMemo(
    () => evidenceFor(results, currentConditions),
    [results, currentConditions]
  )

  return { isLocalEngine, assessment, currentConditions, evidence }
}

/** Running the compatibility test, its phase and its notice; cancelled on unmount. */
export function useCompatibilityTest({
  modelId,
  providerObject,
  currentConditions,
}: {
  modelId: string | undefined
  providerObject: ModelProvider | undefined
  currentConditions: ReturnType<typeof useModelFitData>['currentConditions']
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const setActiveModels = useAppState((s) => s.setActiveModels)
  const { addResult } = useModelEvidence.getState()
  const [testState, setTestState] = useState<TestState>({ phase: 'idle' })
  const [notice, setNotice] = useState<string>('')
  const abortRef = useRef<AbortController | null>(null)

  // Leaving mid-test cancels it, and the runner releases what it loaded.
  useEffect(() => () => abortRef.current?.abort(), [])

  const runTest = useCallback(
    async (allowUnload: string[] = []) => {
      if (!modelId || !providerObject) return
      const controller = new AbortController()
      abortRef.current = controller
      setTestState({ phase: 'running' })
      setNotice(t('model-fit:test.running'))
      const modelsMax = Number(
        providerObject.settings?.find((s) => s.key === 'models_max')
          ?.controller_props?.value ?? 1
      )
      const startedConditions = currentConditions
      try {
        const outcome = await runCompatibilityTest(
          {
            modelId,
            modelsMax: Number.isFinite(modelsMax) ? modelsMax : 1,
            allowUnload,
            signal: controller.signal,
          },
          {
            getActiveModels: () =>
              serviceHub.models().getActiveModels('llamacpp'),
            startModel: (id) =>
              serviceHub.models().startModel(providerObject, id),
            stopModel: (id) => serviceHub.models().stopModel(id, 'llamacpp'),
            findSession: findSessionByModel,
            fetch: providerFetch,
            now: () => performance.now(),
            isModelIdle: (id) => engineSlotsIdle(id),
          }
        )
        if (outcome.kind === 'needs-confirmation') {
          setTestState({ phase: 'confirm', plan: outcome.plan })
          setNotice(t('model-fit:test.needsConfirmation'))
          return
        }
        if (outcome.kind === 'blocked') {
          setTestState({ phase: 'idle' })
          setNotice(
            outcome.reason === 'model-busy'
              ? t('model-fit:test.blockedBusy', {
                  models: outcome.models.join(', '),
                })
              : t('model-fit:test.blockedInProgress')
          )
          return
        }
        const restoreText =
          outcome.notRestored.length > 0
            ? ` ${t('model-fit:test.notRestored', { models: outcome.notRestored.join(', ') })}`
            : outcome.restored.length > 0
              ? ` ${t('model-fit:test.restored', { models: outcome.restored.join(', ') })}`
              : ''
        if (outcome.kind === 'cancelled') {
          setTestState({ phase: 'idle' })
          setNotice(
            (outcome.released
              ? t('model-fit:test.cancelled')
              : t('model-fit:test.cancelledNotReleased')) + restoreText
          )
          return
        }
        addResult({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          provider: 'llamacpp',
          modelId,
          testedAt: Date.now(),
          outcome: outcome.outcome,
          workload: 'short-reply',
          conditions: {
            ...startedConditions,
            concurrentModels: outcome.concurrentModels,
          },
          metrics: outcome.metrics,
          ...(outcome.error ? { error: outcome.error } : {}),
          unloadedModels: outcome.unloadedModels,
        })
        setTestState({ phase: 'idle' })
        const summary =
          outcome.outcome === 'success'
            ? t('model-fit:test.succeeded')
            : t('model-fit:test.failed', {
                reason: outcome.error?.message ?? '',
              })
        setNotice(
          (outcome.released
            ? summary
            : `${summary} ${t('model-fit:test.notReleased')}`) + restoreText
        )
      } catch (error) {
        setTestState({ phase: 'idle' })
        setNotice(
          t('model-fit:test.couldNotRun', {
            reason: error instanceof Error ? error.message : String(error),
          })
        )
      } finally {
        abortRef.current = null
        serviceHub
          .models()
          .getActiveModels()
          .then((models) => setActiveModels(models || []))
          .catch(() => {})
      }
    },
    [
      modelId,
      providerObject,
      currentConditions,
      serviceHub,
      addResult,
      setActiveModels,
      t,
    ]
  )

  return { testState, setTestState, notice, setNotice, abortRef, runTest }
}
