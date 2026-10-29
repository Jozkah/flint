/* eslint-disable react-refresh/only-export-components */
import { cn, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAppState } from '@/hooks/useAppState'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { offloadFor, useGpuOffload } from '@/hooks/useGpuOffload'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  runtimeVersion,
  useCompatibilityTest,
  useModelFitData,
} from '@/hooks/useModelFit'
import {
  tierForVerdict,
  type FitAssessment,
  type FitTier,
} from '@/lib/modelCompatibility'
import {
  resultKey,
  type ConditionDifference,
  type EvidenceState,
  type TestMetrics,
} from '@/lib/modelEvidence'

interface ModelSupportStatusProps {
  modelId: string | undefined
  provider: string | undefined
  contextSize: number
  className?: string
  /** Opens the model's settings so a failed configuration can be adjusted. */
  onAdjustSettings?: () => void
}

const DOT_CLASS: Record<FitTier, string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
  unknown: 'bg-border-strong',
}

/** A measured result outranks the estimate for the colour of the dot. */
function tierFor(state: EvidenceState, assessment: FitAssessment): FitTier {
  if (state === 'ran-successfully') return 'green'
  if (state === 'failed-with-settings' || state === 'unsupported') return 'red'
  return tierForVerdict(assessment.verdict)
}

export { runtimeVersion }

const bytes = (value: number) => formatBytes(value, { decimals: 1 })

export const ModelSupportStatus = ({
  modelId,
  provider,
  contextSize,
  className,
  onAdjustSettings,
}: ModelSupportStatusProps) => {
  const { t } = useTranslation()
  const providerObject = useModelProvider((s) =>
    provider ? s.getProviderByName(provider) : undefined
  )
  const activeModels = useAppState((s) => s.activeModels)
  const offload = useGpuOffload((s) =>
    modelId && activeModels.includes(modelId)
      ? offloadFor(s, modelId, activeModels)
      : undefined
  )
  const preferredModel = useModelEvidence((s) => s.preferredModel)
  const dismissed = useModelEvidence((s) =>
    provider && modelId
      ? s.dismissedHints.includes(resultKey(provider, modelId))
      : false
  )
  const { setPreferredModel, dismissHint, restoreHint } =
    useModelEvidence.getState()

  const { isLocalEngine, assessment, currentConditions, evidence } = useModelFitData({
    modelId,
    provider,
    contextSize,
    providerObject,
    activeModels,
  })
  const { testState, setTestState, notice, setNotice, abortRef, runTest } =
    useCompatibilityTest({ modelId, providerObject, currentConditions })

  if (!modelId || !provider || !isLocalEngine) return null
  if (
    assessment.verdict === 'unknown' &&
    evidence.state === 'not-tested' &&
    !offload
  ) {
    return null
  }

  const tier = dismissed ? 'unknown' : tierFor(evidence.state, assessment)
  const headline = evidenceHeadline(evidence.state, t)
  const estimate = t(`model-fit:verdict.${assessment.verdict}`)
  const isPreferred =
    preferredModel?.provider === provider && preferredModel?.model === modelId
  const running = testState.phase === 'running'

  const fitLabel = t('model-fit:triggerLabel', {
    status: dismissed ? estimate : `${headline}. ${estimate}`,
  })
  return (
    // The picker's trigger wraps this; keep clicks and keys from toggling it.
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn('flex items-center', className)}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-8"
            aria-label={fitLabel}
            // The dot alone says nothing; hovering names what it means.
            title={fitLabel}
          >
            <span
              className={cn('size-2 rounded-full', DOT_CLASS[tier])}
              aria-hidden
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-96 max-w-[calc(100vw-1.5rem)] max-h-[70vh] overflow-y-auto overscroll-contain bg-card text-sm space-y-3"
        >
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('model-fit:title')}
            </h3>
            <p className="text-muted-foreground text-xs mt-0.5">
              {t('model-fit:subtitle')}
            </p>
          </div>

          {/* Measured on this device and Estimate are two different kinds of
              claim, so they are two visibly different blocks: a solid paper
              card for what was observed, a dashed sunken one for arithmetic. */}
          <section
            aria-labelledby="model-fit-measured"
            className="space-y-1 rounded-md border border-border bg-card p-2.5"
          >
            <h4 id="model-fit-measured" className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">
              {t('model-fit:measuredHeading')}
            </h4>
            <p>{headline}</p>
            {evidence.latest && evidence.state !== 'not-tested' && (
              <MeasuredDetails
                metrics={evidence.latest.metrics}
                testedAt={evidence.latest.testedAt}
                settings={evidence.latest.conditions.settings}
                error={evidence.latest.error?.message}
                outcome={evidence.latest.outcome}
              />
            )}
            {evidence.state === 'stale' && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {evidence.differences.map((d, i) => (
                  <li key={i}>{describeDifference(d, t)}</li>
                ))}
              </ul>
            )}
            {evidence.state === 'failed-with-settings' && evidence.otherSuccess && (
              <p className="text-xs text-muted-foreground">
                {t('model-fit:otherSuccess', {
                  context:
                    evidence.otherSuccess.conditions.settings.ctx_len ?? '—',
                })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('model-fit:testScope')}
            </p>
          </section>

          {offload && (
            <section
              aria-labelledby="model-fit-offload"
              className="space-y-1 rounded-md border border-border bg-card p-2.5"
            >
              <h4
                id="model-fit-offload"
                className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground"
              >
                {t('model-fit:offload.heading')}
              </h4>
              <p>
                {offload.totalLayers === 0
                  ? t('model-fit:offload.unknown')
                  : offload.gpuLayers === 0
                    ? t('model-fit:offload.none')
                    : offload.gpuLayers >= offload.totalLayers
                      ? t('model-fit:offload.all', {
                          layers: offload.totalLayers,
                        })
                      : t('model-fit:offload.partial', {
                          gpu: offload.gpuLayers,
                          total: offload.totalLayers,
                        })}
              </p>
              {(offload.gpuMib > 0 || offload.cpuMib > 0) && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t('model-fit:offload.memory', {
                    gpu: bytes(offload.gpuMib * 1024 * 1024),
                    cpu: bytes(offload.cpuMib * 1024 * 1024),
                  })}
                </p>
              )}
            </section>
          )}

          <section
            aria-labelledby="model-fit-estimate"
            className="space-y-1 rounded-md border border-dashed border-border-strong bg-muted p-2.5"
          >
            <h4 id="model-fit-estimate" className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">
              {t('model-fit:estimateHeading')}
            </h4>
            <p>{estimate}</p>
            <p className="text-xs text-muted-foreground">
              {t(`model-fit:memoryModel.${assessment.memoryModel}`, {
                ram: bytes(assessment.budgets.systemRam),
                vram: bytes(assessment.budgets.dedicatedVram),
                gpu: bytes(assessment.budgets.gpu),
              })}
            </p>
            <MemoryBars
              need={assessment.required.total}
              available={assessment.budgets.total}
            />
            {/* Confidence is part of the estimate, not a detail behind a
                disclosure: it says how much weight the verdict can bear. */}
            <p className="text-xs text-fg-2">
              {t(`model-fit:uncertainty.${assessment.uncertainty}`)}
            </p>
            <Collapsible>
              <CollapsibleTrigger className="text-xs text-acc-text underline underline-offset-2 rounded-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring">
                {t('model-fit:showReasons')}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2 space-y-2 text-xs">
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
                  <dt>{t('model-fit:breakdown.weights')}</dt>
                  <dd className="text-right">{bytes(assessment.required.weights)}</dd>
                  <dt>
                    {t('model-fit:breakdown.kvCache', {
                      tokens: assessment.effectiveContext.toLocaleString(),
                    })}
                  </dt>
                  <dd className="text-right">{bytes(assessment.required.kvCache)}</dd>
                  {assessment.required.mmproj > 0 && (
                    <>
                      <dt>{t('model-fit:breakdown.mmproj')}</dt>
                      <dd className="text-right">{bytes(assessment.required.mmproj)}</dd>
                    </>
                  )}
                  <dt>{t('model-fit:breakdown.overhead')}</dt>
                  <dd className="text-right">{bytes(assessment.required.runtimeOverhead)}</dd>
                  <dt className="font-medium">{t('model-fit:breakdown.total')}</dt>
                  <dd className="text-right font-medium">{bytes(assessment.required.total)}</dd>
                  <dt>{t('model-fit:breakdown.budget')}</dt>
                  <dd className="text-right">{bytes(assessment.budgets.total)}</dd>
                  {assessment.budgets.otherLoaded > 0 && (
                    <>
                      <dt>{t('model-fit:breakdown.otherLoaded')}</dt>
                      <dd className="text-right">{bytes(assessment.budgets.otherLoaded)}</dd>
                    </>
                  )}
                </dl>
                <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                  {assessment.assumptions.map((a) => (
                    <li key={a}>{t(`model-fit:assumption.${a}`)}</li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </section>

          {testState.phase === 'confirm' && (
            <div
              role="alertdialog"
              aria-labelledby="model-fit-confirm"
              className="rounded-md border border-warning/40 bg-warning-tint p-2 space-y-2"
            >
              <p id="model-fit-confirm">
                {t('model-fit:test.confirmUnload', {
                  models: testState.plan.willUnload.join(', '),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                {/* Focus starts on the answer that changes nothing. */}
                <Button
                  size="sm"
                  variant="outline"
                  autoFocus
                  className="pointer-coarse:h-11"
                  onClick={() => {
                    setTestState({ phase: 'idle' })
                    setNotice('')
                  }}
                >
                  {t('model-fit:test.dontTest')}
                </Button>
                {/* Unloading stops whatever that model is writing: outlined
                    destructive, never the accent fill. */}
                <Button
                  size="sm"
                  variant="destructive"
                  className="pointer-coarse:h-11"
                  onClick={() => runTest(testState.plan.willUnload)}
                >
                  {t('model-fit:test.unloadAndTest')}
                </Button>
              </div>
            </div>
          )}

          <p role="status" aria-live="polite" className="text-xs min-h-4">
            {notice}
          </p>

          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => abortRef.current?.abort()}
              >
                {t('model-fit:test.cancel')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => runTest()}
                disabled={testState.phase === 'confirm' || !providerObject}
              >
                {evidence.state === 'not-tested'
                  ? t('model-fit:test.run')
                  : t('model-fit:test.runAgain')}
              </Button>
            )}
            {onAdjustSettings && (
              <Button size="sm" variant="outline" onClick={onAdjustSettings}>
                {t('model-fit:adjustSettings')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              aria-pressed={isPreferred}
              onClick={() =>
                setPreferredModel(
                  isPreferred ? null : { provider, model: modelId }
                )
              }
            >
              {isPreferred
                ? t('model-fit:removeDefault')
                : t('model-fit:setDefault')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                dismissed
                  ? restoreHint(provider, modelId)
                  : dismissHint(provider, modelId)
              }
            >
              {dismissed ? t('model-fit:showHint') : t('model-fit:hideHint')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('model-fit:testExplainer')}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  )
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The estimate's two totals as bars on one scale: what the model is estimated
 * to need beside what is estimated to be available. An estimate above the
 * budget is drawn in the warning colour, never the destructive one: it is
 * advice, and selecting or testing the model stays possible.
 */
function MemoryBars({ need, available }: { need: number; available: number }) {
  const { t } = useTranslation()
  if (!(need > 0) || !(available > 0)) return null
  const scale = Math.max(need, available)
  const rows = [
    {
      label: t('model-fit:breakdown.total'),
      value: need,
      fill: need > available ? 'bg-warning' : 'bg-fg-2',
    },
    {
      label: t('model-fit:breakdown.budget'),
      value: available,
      fill: 'bg-muted-foreground',
    },
  ]
  return (
    <dl
      aria-label={t('model-fit:memoryBars')}
      className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs tabular-nums"
    >
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-fg-2">{row.label}</dt>
          <dd aria-hidden className="h-1.5 overflow-hidden rounded-full bg-border">
            <span
              className={cn('block h-full rounded-full', row.fill)}
              style={{ width: `${Math.round((row.value / scale) * 100)}%` }}
            />
          </dd>
          <dd className="text-right text-foreground">{bytes(row.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

function evidenceHeadline(state: EvidenceState, t: Translate): string {
  return t(`model-fit:evidence.${state}`)
}

function describeDifference(d: ConditionDifference, t: Translate): string {
  switch (d.kind) {
    case 'settings':
      return t('model-fit:difference.settings', { keys: d.keys.join(', ') })
    case 'runtime':
      return t('model-fit:difference.runtime', {
        recorded: d.recorded,
        current: d.current,
      })
    case 'device':
      return t('model-fit:difference.device')
    case 'model-file':
      return t('model-fit:difference.modelFile')
  }
}

function MeasuredDetails({
  metrics,
  testedAt,
  settings,
  error,
  outcome,
}: {
  metrics: TestMetrics
  testedAt: number
  settings: Record<string, unknown>
  error?: string
  outcome: 'success' | 'failure'
}) {
  const { t } = useTranslation()
  const rows: [string, string][] = []
  if (metrics.loadMs !== undefined) {
    rows.push([t('model-fit:metric.load'), `${(metrics.loadMs / 1000).toFixed(1)} s`])
  }
  if (metrics.generationTokensPerSecond !== undefined) {
    rows.push([
      t('model-fit:metric.generation'),
      `${metrics.generationTokensPerSecond.toFixed(1)} tok/s`,
    ])
  }
  if (metrics.promptTokensPerSecond !== undefined) {
    rows.push([
      t('model-fit:metric.prompt'),
      `${metrics.promptTokensPerSecond.toFixed(1)} tok/s`,
    ])
  }
  const settingText = Object.entries(settings)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
  return (
    <div className="text-xs space-y-1">
      <p className="text-muted-foreground">
        {t('model-fit:testedAt', {
          when: new Date(testedAt).toLocaleString(),
          settings: settingText || t('model-fit:defaultSettings'),
        })}
      </p>
      {outcome === 'failure' && error && (
        <p className="text-destructive break-words">{error}</p>
      )}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 tabular-nums">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
