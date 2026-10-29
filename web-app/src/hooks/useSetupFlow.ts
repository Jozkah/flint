import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useSetupChecklist } from '@/hooks/useSetupChecklist'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import {
  engineBackendNameOf,
  FINISH_STEP,
  isPageSettled as isPageSettledFor,
  isSetupStagesComplete,
  setupPageFromStages,
  WELCOME_STEP,
  type WizardStep,
} from '@/lib/setupFlow'

/**
 * The setup wizard's step machine (Q2-022): where setup resumes, starting
 * the engine, the readiness checks, which page is current and which pages
 * the user has passed.
 */
export function useSetupFlow({
  guide,
  threadCount,
}: {
  guide: ReturnType<typeof useOnboardingGuide.getState>
  threadCount: number
}) {
  const serviceHub = useServiceHub()
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

  /** Pages the user has passed despite a warning; they must not reappear. */
  const [acknowledged, setAcknowledged] = useState<string[]>(() =>
    resumedFrom === 'finish' ? ['setup'] : []
  )

  const setupPage = useMemo<WizardStep>(
    () => setupPageFromStages(stages),
    [stages]
  )

  // Advanced only on the user's say-so. Auto-advancing skipped this page
  // entirely whenever the engine was already installed, which hid the GPU badge
  // -- the one thing on it the user cannot see anywhere else.
  const isSetupSettled = acknowledged.includes('setup')
  const isSetupComplete = isSetupStagesComplete(stages)
  const engineBackendName = engineBackendNameOf(stages)

  const pages = useMemo<WizardStep[]>(
    () => [WELCOME_STEP, setupPage, FINISH_STEP],
    [setupPage]
  )

  const isPageSettled = useCallback(
    (page: WizardStep) =>
      isPageSettledFor(page, { hasStarted, isSetupSettled }),
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

  return {
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
  }
}
