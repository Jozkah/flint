import type { SetupStageState } from '@/hooks/useSetupChecklist'

/**
 * One page of the setup flow. The last page is not a readiness probe, so it
 * does not come from `useSetupChecklist` with the others.
 */
export type WizardStep = {
  id: string
  labelKey: string
  status: SetupStageState['status']
  messageKey: string
  values?: Record<string, string | number>
  detail?: string
}

type StageLike = Pick<
  SetupStageState,
  'id' | 'status' | 'messageKey' | 'values' | 'detail'
>

export const WELCOME_STEP: WizardStep = {
  id: 'welcome',
  labelKey: 'setup:welcomeTitle',
  status: 'pending',
  messageKey: '',
}

// The last page reports nothing and waits for nothing: it is where the user
// decides how to start, so its status is fixed.
export const FINISH_STEP: WizardStep = {
  id: 'finish',
  labelKey: 'setup:stageFinish',
  status: 'pending',
  messageKey: '',
}

/**
 * The three readiness probes collapse into a single "set up llama.cpp" page:
 * the backend download and the embedding install are one wait from the user's
 * point of view, and the hardware probe only exists to label the GPU badge.
 */
export function setupPageFromStages(stages: readonly StageLike[]): WizardStep {
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
}

/** All three probes behind the setup page report ok. */
export function isSetupStagesComplete(stages: readonly StageLike[]): boolean {
  return ['engine', 'search', 'system'].every(
    (id) => stages.find((stage) => stage.id === id)?.status === 'ok'
  )
}

/** The backend asset name, shown as a caption rather than as prose. */
export function engineBackendNameOf(stages: readonly StageLike[]): string {
  return String(
    stages.find((stage) => stage.id === 'engine')?.values?.backend ?? ''
  )
}

/** Whether a page has been passed: welcome once started, setup once acknowledged. */
export function isPageSettled(
  page: WizardStep,
  state: { hasStarted: boolean; isSetupSettled: boolean }
): boolean {
  switch (page.id) {
    case 'welcome':
      return state.hasStarted
    case 'setup':
      return state.isSetupSettled
    default:
      // The last page ends the flow itself, so it never settles on its own.
      return false
  }
}
