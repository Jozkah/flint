import { useModelProvider } from '@/hooks/useModelProvider'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { localStorageKey } from '@/constants/localStorage'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useMemo, useCallback, useRef } from 'react'
import { AppEvent, events } from '@janhq/core'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Check, Info, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSetupFlow } from '@/hooks/useSetupFlow'
import HeaderPage from './HeaderPage'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useThreads } from '@/hooks/useThreads'
import { destinationFor } from '@/lib/onboarding'
import { isChatCapable } from '@/lib/providerReadiness'
import { SetupProgress } from './setup/SetupProgress'
import { IntentionList } from './setup/IntentionList'
import { EngineInstallStatus } from './setup/EngineInstallStatus'
import { ModelPickStep } from './setup/ModelPickStep'

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
  const guide = useOnboardingGuide()
  const threadCount = useThreads((s) => Object.keys(s.threads ?? {}).length)
  const {
    resumed,
    beginSetup,
    skipGuide,
    gpu,
    warnings,
    isRunning,
    rerun,
    pages,
    currentIndex,
    currentPage,
    acknowledge,
    isSetupComplete,
    engineBackendName,
  } = useSetupFlow({ guide, threadCount })

  // Use ref to track if we've already navigated
  const hasNavigatedRef = useRef(false)
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


  /**
   * Local models already on disk that can hold a conversation. The embedding
   * model Flint installs for itself is left out: starting a chat with it would
   * end onboarding with nothing able to answer.
   */
  const localModels = useMemo(
    () => (llamaProvider?.models ?? []).filter(isChatCapable),
    [llamaProvider]
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
                <SetupProgress pages={pages} currentIndex={currentIndex} />

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
                    <IntentionList
                      intent={guide.intent}
                      onIntent={guide.setIntent}
                    />
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

                {isSetupPage && (
                  <EngineInstallStatus
                    page={currentPage}
                    gpu={gpu}
                    warnings={warnings}
                    isWarning={isWarning}
                    isSetupComplete={isSetupComplete}
                    isRunning={isRunning}
                    engineBackendName={engineBackendName}
                    onContinue={() => acknowledge('setup')}
                    onRerun={() => void rerun()}
                  />
                )}

                {currentPage.id === 'finish' && (
                  <ModelPickStep
                    localModels={localModels}
                    onConnectRemote={() =>
                      navigate({ to: route.settings.model_providers })
                    }
                    onFinish={(modelId) => void completeSetup(modelId)}
                  />
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
