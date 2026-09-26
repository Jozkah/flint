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
  AlertTriangle,
  ArrowRight,
  Check,
  Cpu,
  Info,
  Loader2,
} from 'lucide-react'
import { cn, getModelDisplayName } from '@/lib/utils'
import {
  useSetupChecklist,
  type SetupStageState,
} from '@/hooks/useSetupChecklist'
import { DependencyAdvice } from './dialogs/DependencyAdvice'
import HeaderPage from './HeaderPage'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useThreads } from '@/hooks/useThreads'
import { destinationFor, INTENTS } from '@/lib/onboarding'
import { isChatCapable } from '@/lib/providerReadiness'

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

type SetupScreenProps = {
  /** Called once onboarding ends, so the host stops rendering this screen. */
  onFinished?: () => void
}

function SetupScreen({ onFinished }: SetupScreenProps = {}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { getProviderByName, selectModelProvider, setProviders } =
    useModelProvider()

  const serviceHub = useServiceHub()
  const llamaProvider = getProviderByName('llamacpp')
  /** Whichever local model the user picks on the last page, if any. */
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  const guide = useOnboardingGuide()
  const threadCount = useThreads((s) => Object.keys(s.threads ?? {}).length)
  // Where setup was left last time. Read once: resuming is a starting point,
  // not something to keep re-deciding while the user moves through the pages.
  const [resumedFrom] = useState(
    () => useOnboardingGuide.getState().setupPage
  )
  const resumed = resumedFrom !== 'welcome'

  // Nothing is probed until the user starts: the first page is an invitation,
  // not a progress report. A setup the user already started resumes.
  const [hasStarted, setHasStarted] = useState(resumed)
  const startEngine = useCallback(() => {
    setHasStarted(true)
    guide.setSetupPage('setup')
    // Not awaited: the readiness checks are what report its progress.
    void serviceHub.models().startEngineSetup()
  }, [serviceHub, guide])
  const beginSetup = useCallback(() => {
    guide.start(guide.intent, threadCount)
    startEngine()
  }, [guide, threadCount, startEngine])
  /** Setup still runs; only the guide on the home screen is left out. */
  const skipGuide = useCallback(() => {
    guide.skip()
    startEngine()
  }, [guide, startEngine])
  useEffect(() => {
    if (resumed) void serviceHub.models().startEngineSetup()
    // Once, for a resumed setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const { stages, warnings, gpu, isRunning, rerun } = useSetupChecklist({
    enabled: hasStarted,
  })
  const [showDetails, setShowDetails] = useState(false)



  // Use ref to track if we've already navigated
  const hasNavigatedRef = useRef(false)
  /** Pages the user has passed despite a warning; they must not reappear. */
  const [acknowledged, setAcknowledged] = useState<string[]>(() =>
    resumedFrom === 'finish' ? ['setup'] : []
  )

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
      useOnboardingGuide.getState().setSetupPage('welcome')
      onFinished?.()

      if (!modelId) {
        navigate({ to: route.home, replace: true, search: {} })
        return
      }

      selectModelProvider('llamacpp', modelId)
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({ provider: 'llamacpp', model: modelId })
      )
      // Project work continues in Cowork with the chosen model selected; the
      // other intentions start from a new chat.
      const intent = useOnboardingGuide.getState().intent
      if (destinationFor(intent) === route.cowork) {
        navigate({ to: route.cowork, replace: true })
        return
      }
      navigate({
        to: route.home,
        replace: true,
        search: { threadModel: { id: modelId, provider: 'llamacpp' } },
      })
    },
    [navigate, selectModelProvider, onFinished]
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

  /**
   * Local models already on disk that can hold a conversation. The embedding
   * model Flint installs for itself is left out: starting a chat with it would
   * end onboarding with nothing able to answer.
   */
  const localModels = useMemo(
    () => (llamaProvider?.models ?? []).filter(isChatCapable),
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


  const acknowledge = useCallback(
    (id: string) => {
      setAcknowledged((prev) => (prev.includes(id) ? prev : [...prev, id]))
      if (id === 'setup') guide.setSetupPage('finish')
    },
    [guide]
  )


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

        {/* Scrolls rather than clips: on a short window the intentions and the
            finish page are taller than the space, and centring with
            items-center pushed the primary actions out of reach. */}
        <div className="flex h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-6 sm:px-6">

          <div
            className="m-auto w-full min-w-0 max-w-[480px] rounded-[14px] border-[0.8px] border-border bg-card p-5 shadow-pop pointer-events-auto motion-safe:animate-dlg-in sm:p-6"
            data-testid="setup-wizard"
            data-page={currentPage?.id ?? 'done'}
          >
            {currentPage && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <span
                    className="text-xs font-medium tabular-nums text-muted-foreground"
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
                          'h-1 w-6 rounded-full motion-safe:transition-colors',
                          index === currentIndex
                            ? 'bg-primary'
                            : index < currentIndex
                              ? 'bg-secondary-foreground'
                              : 'bg-track'
                        )}
                      />
                    ))}
                  </span>
                </div>

                <div className="mt-4">
                  {isSetupPage && (
                    <span
                      className={cn(
                        'mb-4 inline-flex size-9 items-center justify-center rounded-md',
                        isWarning
                          ? 'bg-destructive-tint text-destructive'
                          : isSetupComplete
                            ? 'bg-success-tint text-success'
                            : 'bg-accent text-muted-foreground'
                      )}
                    >
                      {isWarning ? (
                        <AlertTriangle className="size-[18px]" />
                      ) : isSetupComplete ? (
                        <Check className="size-[18px]" />
                      ) : (
                        <Loader2 className="size-[18px] motion-safe:animate-spin" />
                      )}
                    </span>
                  )}
                  <h1 className="text-base font-semibold leading-snug text-foreground">
                    {isSetupPage && isSetupComplete
                      ? t('setup:stageSetupDone')
                      : t(currentPage.labelKey)}
                  </h1>
                  {body() && (
                    <p className="mt-2 text-sm leading-relaxed text-fg-2">
                      {body()}
                    </p>
                  )}
                </div>

                {resumed && currentPage.id !== 'welcome' && (
                  <p
                    role="status"
                    className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-fg-2"
                    data-testid="setup-resumed"
                  >
                    <Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                    <span>{t('onboarding:resumeNotice')}</span>
                  </p>
                )}

                {currentPage.id === 'welcome' && (
                  <>
                    <fieldset className="mt-5" data-testid="setup-intents">
                      <legend className="text-sm font-semibold text-foreground">
                        {t('onboarding:intentHeading')}
                      </legend>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('onboarding:intentHint')}
                      </p>
                      <div
                        role="radiogroup"
                        aria-label={t('onboarding:intentHeading')}
                        className="mt-3 flex flex-col gap-2"
                        onKeyDown={(event) => {
                          // Arrow keys move and select within the group, as a
                          // native radio group does; Tab still leaves it.
                          const step =
                            event.key === 'ArrowDown' || event.key === 'ArrowRight'
                              ? 1
                              : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                                ? -1
                                : 0
                          if (!step) return
                          event.preventDefault()
                          // With nothing chosen yet, the first arrow picks the
                          // first (down) or last (up) option.
                          const current = guide.intent
                            ? INTENTS.indexOf(guide.intent)
                            : step > 0
                              ? -1
                              : 0
                          const next =
                            INTENTS[(current + step + INTENTS.length) % INTENTS.length]
                          guide.setIntent(next)
                          ;(
                            event.currentTarget.querySelector(
                              `[data-testid="setup-intent-${next}"]`
                            ) as HTMLElement | null
                          )?.focus()
                        }}
                      >
                        {INTENTS.map((intent) => {
                          const isChosen = guide.intent === intent
                          return (
                            <button
                              key={intent}
                              type="button"
                              role="radio"
                              aria-checked={isChosen}
                              data-testid={`setup-intent-${intent}`}
                              onClick={() => guide.setIntent(intent)}
                              className={cn(
                                'flex min-h-11 items-start gap-3 rounded-lg border-[0.8px] px-3.5 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
                                isChosen
                                  ? 'border-primary bg-accent'
                                  : 'border-border bg-card hover:border-border-strong hover:bg-hover-row'
                              )}
                            >
                              {/* The radio mark: a ring, filled when chosen. */}
                              <span
                                aria-hidden
                                className={cn(
                                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                                  isChosen ? 'border-primary' : 'border-input'
                                )}
                              >
                                {isChosen && (
                                  <span className="size-2 rounded-full bg-primary" />
                                )}
                              </span>
                              <span className="min-w-0">
                                <span className="block font-medium text-foreground">
                                  {t(`onboarding:intent.${intent}.title`)}
                                </span>
                                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                                  {t(`onboarding:intent.${intent}.description`)}
                                </span>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </fieldset>
                    <Button
                      size="lg"
                      className="mt-5 w-full pointer-coarse:h-11"
                      onClick={beginSetup}
                    >
                      {t('setup:startSetup')}
                    </Button>
                    <Button
                      variant="link"
                      className="mt-1 w-full pointer-coarse:h-11"
                      data-testid="setup-skip-guide"
                      onClick={skipGuide}
                    >
                      {t('onboarding:skipGuide')}
                    </Button>
                  </>
                )}

                {/* The one fact a user cannot infer from a progress line:
                    whether the work they are waiting for lands on the GPU. */}
                {isSetupPage && (
                  <div
                    className={cn(
                      'mt-5 flex items-start gap-2.5 rounded-md border px-3.5 py-3',
                      gpu.willUse
                        ? 'border-success/30 bg-success-tint'
                        : 'border-border bg-muted'
                    )}
                    data-testid="setup-gpu-badge"
                  >
                    <span
                      className={cn(
                        'mt-0.5 shrink-0',
                        gpu.willUse ? 'text-success' : 'text-muted-foreground'
                      )}
                    >
                      {gpu.willUse === undefined ? (
                        <Loader2 className="size-[15px] motion-safe:animate-spin" />
                      ) : gpu.willUse ? (
                        <Check className="size-[15px]" />
                      ) : (
                        <Cpu className="size-[15px]" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p
                        className={cn(
                          'text-sm font-medium',
                          gpu.willUse ? 'text-success' : 'text-foreground'
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
                          aria-expanded={showDetails}
                          className="rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
                          onClick={() => setShowDetails((prev) => !prev)}
                        >
                          {showDetails
                            ? t('setup:hideDetails')
                            : t('setup:showDetails')}
                        </button>
                        {showDetails && (
                          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2.5 font-mono text-xs text-fg-2">
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
                      <p
                        className="mt-3 truncate font-mono text-[11px] text-muted-foreground"
                        title={engineBackendName}
                      >
                        {engineBackendName}
                      </p>
                    )}
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      {/* Continue once the work is done; the same button skips
                          ahead while it is still running, since this page covers
                          a backend download and waiting must not be the only
                          option. */}
                      <Button
                        className="flex-1 pointer-coarse:h-11"
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
                    <section
                      aria-labelledby="setup-processing-heading"
                      className="mb-4 rounded-md border border-border bg-muted px-3.5 py-3 text-xs leading-relaxed"
                      data-testid="setup-processing"
                    >
                      <h2
                        id="setup-processing-heading"
                        className="text-sm font-semibold text-foreground"
                      >
                        {t('onboarding:processingHeading')}
                      </h2>
                      <p className="mt-1.5 text-fg-2">
                        {t('onboarding:processingLocal')}
                      </p>
                      <p className="mt-1.5 text-fg-2">
                        {t('onboarding:processingRemote')}
                      </p>
                      <Button
                        variant="link"
                        className="mt-1 h-auto px-0 text-xs pointer-coarse:min-h-11"
                        data-testid="setup-connect-remote"
                        onClick={() =>
                          navigate({ to: route.settings.model_providers })
                        }
                      >
                        {t('onboarding:connectRemote')}
                      </Button>
                    </section>
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
                                'flex min-h-11 items-center justify-between gap-2 rounded-lg border-[0.8px] px-3.5 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
                                isChosen
                                  ? 'border-primary bg-accent'
                                  : 'border-border bg-card hover:border-border-strong hover:bg-hover-row'
                              )}
                            >
                              <span className="truncate">
                                {getModelDisplayName(model)}
                              </span>
                              {isChosen && (
                                <Check className="size-4 shrink-0 text-acc-text" />
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

                    <div className="mt-5 flex flex-wrap items-center gap-2">
                      <Button
                        data-testid="setup-finish-start"
                        className="pointer-coarse:h-11"
                        onClick={() =>
                          void completeSetup(chosenModel ?? undefined)
                        }
                      >
                        {chosenModel
                          ? t('setup:finishStartChat')
                          : t('setup:finishWithoutModel')}
                        <ArrowRight className="size-4" />
                      </Button>
                      <Button
                        variant="link"
                        className="pointer-coarse:h-11"
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
