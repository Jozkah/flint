import { route } from '@/constants/routes'

/**
 * The first-run guide, as data.
 *
 * A guide step is either observed from real state (a usable model exists, a
 * conversation was started after the guide began) or confirmed by the user
 * ("I attached a document"). Nothing here fabricates progress, and the guide
 * never creates threads, files or activity on the user's behalf.
 */

export const INTENTS = ['question', 'documents', 'project'] as const
export type Intent = (typeof INTENTS)[number]

export type GuideStatus = 'not-started' | 'in-progress' | 'skipped' | 'completed'

/** Where the setup screen was when it was left, so it can resume there. */
export type SetupPage = 'welcome' | 'setup' | 'finish'

export type GuideStepId =
  | 'choose-model'
  | 'add-material'
  | 'first-task'
  | 'review-context'

export interface GuideState {
  status: GuideStatus
  intent: Intent | null
  /** Conversations that existed when the guide started; newer ones count. */
  threadCountAtStart: number
  /** Steps the user confirmed themselves. */
  confirmedSteps: GuideStepId[]
  setupPage: SetupPage
}

export interface GuideSignals {
  /** A provider with a chat model the user can send to. */
  hasUsableModel: boolean
  threadCount: number
}

/** Which steps each intention walks through, in order. */
export function guideSteps(intent: Intent | null): GuideStepId[] {
  switch (intent) {
    case 'documents':
      return ['choose-model', 'add-material', 'first-task', 'review-context']
    case 'project':
      return ['choose-model', 'add-material', 'first-task']
    case 'question':
    default:
      return ['choose-model', 'first-task']
  }
}

/** Steps whose completion is observed rather than confirmed. */
const OBSERVED: ReadonlySet<GuideStepId> = new Set(['choose-model', 'first-task'])

export function isObservedStep(step: GuideStepId): boolean {
  return OBSERVED.has(step)
}

export function isStepDone(
  step: GuideStepId,
  state: GuideState,
  signals: GuideSignals
): boolean {
  switch (step) {
    case 'choose-model':
      return signals.hasUsableModel
    case 'first-task':
      return signals.threadCount > state.threadCountAtStart
    default:
      return state.confirmedSteps.includes(step)
  }
}

export function remainingSteps(
  state: GuideState,
  signals: GuideSignals
): GuideStepId[] {
  return guideSteps(state.intent).filter((s) => !isStepDone(s, state, signals))
}

export function shouldShowGuide(
  state: GuideState,
  signals: GuideSignals
): boolean {
  return state.status === 'in-progress' && remainingSteps(state, signals).length > 0
}

/** Where to go once a model is chosen, for each intention. */
export function destinationFor(intent: Intent | null): string {
  return intent === 'project' ? route.cowork : route.home
}

export const INITIAL_GUIDE_STATE: GuideState = {
  status: 'not-started',
  intent: null,
  threadCountAtStart: 0,
  confirmedSteps: [],
  setupPage: 'welcome',
}
