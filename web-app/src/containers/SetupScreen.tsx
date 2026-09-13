import { useModelProvider } from '@/hooks/useModelProvider'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { localStorageKey } from '@/constants/localStorage'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useMemo, useCallback, useState, useRef } from 'react'
import { AppEvent, events } from '@janhq/core'
import { Button } from '@/components/ui/button'
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconCpu,
  IconLoader2,
} from '@tabler/icons-react'
import { cn, getModelDisplayName } from '@/lib/utils'
import {
  useSetupChecklist,
  type SetupStageState,
} from '@/hooks/useSetupChecklist'
import { DependencyAdvice } from './dialogs/DependencyAdvice'
import HeaderPage from './HeaderPage'

/**
 * One page of the setup flow. The last page is not a readiness probe, so it
 * does not come from `useSetupChecklist` with the others.
 */
type WizardStep = {
  id: string
  labelKey: string
  status: SetupStageState['status']
  messageKey: string
  values?: Record<string, string | number>
  detail?: string
}

function SetupScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { getProviderByName, selectModelProvider, setProviders } =
    useModelProvider()

  const serviceHub = useServiceHub()
  const llamaProvider = getProviderByName('llamacpp')
  /** Whichever local model the user picks on the last page, if any. */
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  // Nothing is probed until the user starts: the first page is an invitation,
  // not a progress report.
  const [hasStarted, setHasStarted] = useState(false)
  const beginSetup = useCallback(() => {
    setHasStarted(true)
    // Not awaited: the readiness checks are what report its progress.
    void serviceHub.models().startEngineSetup()
  }, [serviceHub])
  const { stages, warnings, gpu, isRunning, rerun } = useSetupChecklist({
    enabled: hasStarted,
  })
  const [showDetails, setShowDetails] = useState(false)



  // Use ref to track if we've already navigated
  const hasNavigatedRef = useRef(false)
  /** Pages the user has passed despite a warning; they must not reappear. */
  const [acknowledged, setAcknowledged] = useState<string[]>([])

  /**
   * Finish onboarding.
   *
   * Nothing is fetched here. A model is offered only if one is already on
   * disk, and finishing without one is a supported ending — the user can add a
   * model whenever they like from Settings.
   */
  const completeSetup = useCallback(
    async (modelId?: string) => {
      if (hasNavigatedRef.current) return
      hasNavigatedRef.current = true

      localStorage.setItem(localStorageKey.setupCompleted, 'true')

      if (!modelId) {
        navigate({ to: route.home, replace: true, search: {} })
        return
      }

      selectModelProvider('llamacpp', modelId)
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({ provider: 'llamacpp', model: modelId })
      )
      navigate({
        to: route.home,
        replace: true,
        search: { threadModel: { id: modelId, provider: 'llamacpp' } },
      })
    },
    [navigate, selectModelProvider]
  )

  // A model imported while this page is open should appear in the list without
  // the user having to leave and come back.
  useEffect(() => {
    const onModelImported = async () => {
      const providers = await serviceHub.providers().getProviders()
      setProviders(providers)
    }
    events.on(AppEvent.onModelImported, onModelImported)
    return () => {
      events.off(AppEvent.onModelImported, onModelImported)
    }
  }, [serviceHub, setProviders])


  // Named dependencies come from the same warning the standalone dialog would
  // have raised; the advice is rendered inline here instead.
  const dependencyWarning = warnings.find(
    (warning) => (warning.missingLibraries?.length ?? 0) > 0
  )
  const missingLibraries = dependencyWarning?.missingLibraries ?? []
  const dependencyBackend = dependencyWarning?.backend ?? ''

  /** Local models already on disk. There is nowhere else they could come from. */
  const localModels = useMemo(
    () => llamaProvider?.models ?? [],
    [llamaProvider]
  )

  // The last page reports nothing and waits for nothing: it is where the user
  // decides how to start, so its status is fixed.
  const finishStep = useMemo<WizardStep>(
    () => ({
      id: 'finish',
      labelKey: 'setup:stageFinish',
      status: 'pending',
      messageKey: '',
    }),
    []
  )

  // One page at a time, each transient: it gives way as soon as its own
  // condition is met, and the model download is always last.
  //
  // The three readiness probes collapse into a single "set up llama.cpp" page:
  // the backend download and the embedding install are one wait from the user's
  // point of view, and the hardware probe only exists to label the GPU badge.
  const setupPage = useMemo<WizardStep>(() => {
    const byId = new Map(stages.map((stage) => [stage.id, stage]))
    const engine = byId.get('engine')
    const search = byId.get('search')
    const system = byId.get('system')

    // The first unresolved of the three decides what the page reports, so the
    // engine's own progress is shown before the checks that depend on it.
    const reporting =
      [engine, search, system].find((stage) => stage?.status === 'warning') ??
      [engine, search].find((stage) => stage?.status !== 'ok') ??
      engine

    return {
      id: 'setup',
      labelKey: 'setup:stageSetup',
      status: reporting?.status ?? 'pending',
      messageKey: reporting?.messageKey ?? '',
      values: reporting?.values,
      detail: reporting?.detail,
    }
  }, [stages])

  // Advanced only on the user's say-so. Auto-advancing skipped this page
  // entirely whenever the engine was already installed, which hid the GPU badge
  // -- the one thing on it the user cannot see anywhere else.
  const isSetupSettled = acknowledged.includes('setup')
  const isSetupComplete = ['engine', 'search', 'system'].every(
    (id) => stages.find((stage) => stage.id === id)?.status === 'ok'
  )
  /** The backend asset name, shown as a caption rather than as prose. */
  const engineBackendName = String(
    stages.find((stage) => stage.id === 'engine')?.values?.backend ?? ''
  )

  const pages = useMemo<WizardStep[]>(() => {
    const welcome: WizardStep = {
      id: 'welcome',
      labelKey: 'setup:welcomeTitle',
      status: 'pending',
      messageKey: '',
    }
    return [welcome, setupPage, finishStep]
  }, [setupPage, finishStep])

  const isPageSettled = useCallback(
    (page: WizardStep) => {
      switch (page.id) {
        case 'welcome':
          return hasStarted
        case 'setup':
          return isSetupSettled
        default:
          // The last page ends the flow itself, so it never settles on its own.
          return false
      }
    },
    [hasStarted, isSetupSettled]
  )

  const currentIndex = pages.findIndex((page) => !isPageSettled(page))
  const currentPage = currentIndex === -1 ? undefined : pages[currentIndex]


  const acknowledge = useCallback((id: string) => {
    setAcknowledged((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }, [])


  const isWarning = currentPage?.status === 'warning'
  const isSetupPage = currentPage?.id === 'setup'

  // The engine reports its identity as a bare asset name, which is useful as a
  // caption but is not a sentence. The page supplies its own prose.
  const setupBody = isSetupComplete
    ? t('setup:setupDoneBody')
    : currentPage?.messageKey
      ? t(`setup:${currentPage.messageKey}`, currentPage.values)
      : t('setup:stageChecking')

  const body = () => {
    switch (currentPage?.id) {
      case 'welcome':
        return t('setup:welcomeBody')
      case 'finish':
        return t('setup:finishBody')
      default:
        return setupBody
    }
  }

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden">
      <div className="flex flex-col h-full w-full">
        <HeaderPage />

        <div className="flex h-[calc(100%-var(--ctx-h))] items-center justify-center px-6">
          <div
            className="w-full max-w-[460px] rounded-2xl border bg-card/60 p-7 shadow-xl pointer-events-auto"
            data-testid="setup-wizard"
            data-page={currentPage?.id ?? 'done'}
          >
            {currentPage && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <span
                    className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                    data-testid="setup-step-counter"
                  >
                    {t('setup:stepCounter', {
                      current: currentIndex + 1,
                      total: pages.length,
                    })}
                  </span>
                  {/* Segments rather than dots: they read as distance covered,
                      which is what a first-run flow needs to convey. */}
                  <span className="flex items-center gap-1" aria-hidden>
                    {pages.map((page, index) => (
                      <span
                        key={page.id}
                        className={cn(
                          'h-1 w-6 rounded-full transition-colors',
                          index === currentIndex
                            ? 'bg-primary'
                            : index < currentIndex
                              ? 'bg-muted-foreground/50'
                              : 'bg-muted-foreground/15'
                        )}
                      />
                    ))}
                  </span>
                </div>

                <div className="mt-6">
                  {isSetupPage && (
                    <span
                      className={cn(
                        'mb-4 inline-flex size-9 items-center justify-center rounded-xl',
                        isWarning
                          ? 'bg-destructive/10 text-destructive'
                          : isSetupComplete
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {isWarning ? (
                        <IconAlertTriangle size={18} />
                      ) : isSetupComplete ? (
                        <IconCheck size={18} />
                      ) : (
                        <IconLoader2 size={18} className="animate-spin" />
                      )}
                    </span>
                  )}
                  <h1 className="font-studio font-medium text-2xl tracking-tight">
                    {isSetupPage && isSetupComplete
                      ? t('setup:stageSetupDone')
                      : t(currentPage.labelKey)}
                  </h1>
                  {body() && (
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {body()}
                    </p>
                  )}
                </div>

                {currentPage.id === 'welcome' && (
                  <Button className="mt-6 w-full" onClick={beginSetup}>
                    {t('setup:startSetup')}
                  </Button>
                )}

                {/* The one fact a user cannot infer from a progress line:
                    whether the work they are waiting for lands on the GPU. */}
                {isSetupPage && (
                  <div
                    className={cn(
                      'mt-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3',
                      gpu.willUse
                        ? 'border-green-500/25 bg-green-500/8'
                        : 'border-border bg-muted/40'
                    )}
                    data-testid="setup-gpu-badge"
                  >
                    <span
                      className={cn(
                        'mt-0.5 shrink-0',
                        gpu.willUse ? 'text-green-400' : 'text-muted-foreground'
                      )}
                    >
                      {gpu.willUse === undefined ? (
                        <IconLoader2 size={15} className="animate-spin" />
                      ) : gpu.willUse ? (
                        <IconCheck size={15} />
                      ) : (
                        <IconCpu size={15} />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p
                        className={cn(
                          'text-sm font-medium',
                          gpu.willUse ? 'text-green-400' : 'text-foreground'
                        )}
                      >
                        {gpu.willUse === undefined
                          ? t('setup:badgeGpuUnknown')
                          : gpu.willUse
                            ? t('setup:badgeGpu')
                            : t('setup:badgeCpu')}
                      </p>
                      {gpu.label && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {gpu.label}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {isSetupPage && isWarning && (
                  <div className="mt-4" data-testid="setup-page-warning">
                    {warnings.length > 1 && (
                      <p className="mb-2 text-xs text-destructive">
                        {t('setup:otherWarnings', {
                          count: warnings.length - 1,
                        })}
                      </p>
                    )}
                    {currentPage.detail && (
                      <>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline"
                          onClick={() => setShowDetails((prev) => !prev)}
                        >
                          {showDetails
                            ? t('setup:hideDetails')
                            : t('setup:showDetails')}
                        </button>
                        {showDetails && (
                          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
                            {currentPage.detail}
                          </pre>
                        )}
                      </>
                    )}
                    {missingLibraries.length > 0 && (
                      <div className="mt-3">
                        <DependencyAdvice
                          backend={dependencyBackend}
                          missingLibraries={missingLibraries}
                        />
                      </div>
                    )}
                  </div>
                )}

                {isSetupPage && (
                  <>
                    {/* The engine's asset name: a caption, never the sentence. */}
                    {engineBackendName && (
                      <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground/60">
                        {engineBackendName}
                      </p>
                    )}
                    <div className="mt-5 flex items-center gap-3">
                      {/* Continue once the work is done; the same button skips
                          ahead while it is still running, since this page covers
                          a backend download and waiting must not be the only
                          option. */}
                      <Button
                        className="flex-1"
                        onClick={() => acknowledge('setup')}
                      >
                        {isSetupComplete
                          ? t('setup:continueStep')
                          : isWarning
                            ? t('setup:continueAnyway')
                            : t('setup:skipStep')}
                      </Button>
                      {isWarning && !isRunning && (
                        <Button
                          variant="link"
                          onClick={() => void rerun()}
                          className="px-0"
                        >
                          {t('setup:retryChecks')}
                        </Button>
                      )}
                    </div>
                  </>
                )}

                {currentPage.id === 'finish' && (
                  <div className="mt-5" data-testid="setup-finish">
                    {localModels.length > 0 ? (
                      <div
                        role="radiogroup"
                        aria-label={t('setup:finishChooseModel')}
                        className="flex flex-col gap-1.5"
                      >
                        {localModels.map((model) => {
                          const isChosen = chosenModel === model.id
                          return (
                            <button
                              key={model.id}
                              type="button"
                              role="radio"
                              aria-checked={isChosen}
                              data-testid="setup-local-model"
                              onClick={() => setChosenModel(model.id)}
                              className={cn(
                                'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                                isChosen
                                  ? 'border-primary/40 bg-primary/10'
                                  : 'hover:bg-secondary/40'
                              )}
                            >
                              <span className="truncate">
                                {getModelDisplayName(model)}
                              </span>
                              {isChosen && (
                                <IconCheck size={16} className="shrink-0" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t('setup:finishNoModels')}
                      </p>
                    )}

                    <div className="mt-5 flex items-center gap-2">
                      <Button
                        data-testid="setup-finish-start"
                        onClick={() =>
                          void completeSetup(chosenModel ?? undefined)
                        }
                      >
                        {chosenModel
                          ? t('setup:finishStartChat')
                          : t('setup:finishWithoutModel')}
                        <IconArrowRight size={16} />
                      </Button>
                      <Button
                        variant="link"
                        data-testid="setup-finish-import"
                        onClick={() =>
                          navigate({
                            to: route.settings.providers,
                            params: { providerName: 'llamacpp' },
                          })
                        }
                      >
                        {t('setup:finishImport')}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SetupScreen
