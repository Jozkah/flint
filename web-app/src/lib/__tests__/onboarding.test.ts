import { describe, it, expect, beforeEach } from 'vitest'
import {
  destinationFor,
  guideSteps,
  INITIAL_GUIDE_STATE,
  isStepDone,
  remainingSteps,
  shouldShowGuide,
  type GuideState,
} from '../onboarding'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'

const state = (overrides: Partial<GuideState> = {}): GuideState => ({
  ...INITIAL_GUIDE_STATE,
  status: 'in-progress',
  ...overrides,
})

describe('guide steps', () => {
  it('asks only what each intention needs', () => {
    expect(guideSteps('question')).toEqual(['choose-model', 'first-task'])
    expect(guideSteps('documents')).toContain('review-context')
    expect(guideSteps('project')).toContain('add-material')
    expect(guideSteps(null)).toEqual(guideSteps('question'))
  })

  it('observes model choice and the first task from real state', () => {
    const s = state({ intent: 'question', threadCountAtStart: 2 })
    expect(isStepDone('choose-model', s, { hasUsableModel: false, threadCount: 5 })).toBe(false)
    expect(isStepDone('choose-model', s, { hasUsableModel: true, threadCount: 0 })).toBe(true)
    // Conversations that existed before the guide do not count.
    expect(isStepDone('first-task', s, { hasUsableModel: true, threadCount: 2 })).toBe(false)
    expect(isStepDone('first-task', s, { hasUsableModel: true, threadCount: 3 })).toBe(true)
  })

  it('takes user-confirmed steps only from the user', () => {
    const s = state({ intent: 'documents' })
    const signals = { hasUsableModel: true, threadCount: 9 }
    expect(isStepDone('add-material', s, signals)).toBe(false)
    expect(
      isStepDone('add-material', { ...s, confirmedSteps: ['add-material'] }, signals)
    ).toBe(true)
  })

  it('shows the guide only while in progress with steps left', () => {
    const signals = { hasUsableModel: true, threadCount: 1 }
    expect(shouldShowGuide(state({ intent: 'question' }), signals)).toBe(false)
    expect(shouldShowGuide(state({ intent: 'documents' }), signals)).toBe(true)
    expect(remainingSteps(state({ intent: 'documents' }), signals)).toEqual([
      'add-material',
      'review-context',
    ])
    expect(shouldShowGuide(state({ status: 'skipped', intent: 'documents' }), signals)).toBe(false)
  })

  it('sends project work to Cowork and everything else home', () => {
    expect(destinationFor('project')).toBe('/cowork')
    expect(destinationFor('documents')).toBe('/')
    expect(destinationFor(null)).toBe('/')
  })
})

describe('useOnboardingGuide', () => {
  beforeEach(() => {
    useOnboardingGuide.setState({ ...INITIAL_GUIDE_STATE })
  })

  it('starts, records confirmations once, skips and restarts cleanly', () => {
    const guide = useOnboardingGuide.getState()
    guide.start('documents', 4)
    guide.confirmStep('add-material')
    guide.confirmStep('add-material')
    expect(useOnboardingGuide.getState()).toMatchObject({
      status: 'in-progress',
      intent: 'documents',
      threadCountAtStart: 4,
      confirmedSteps: ['add-material'],
    })

    guide.skip()
    expect(useOnboardingGuide.getState().status).toBe('skipped')

    guide.start('project', 7)
    expect(useOnboardingGuide.getState()).toMatchObject({
      status: 'in-progress',
      intent: 'project',
      threadCountAtStart: 7,
      confirmedSteps: [],
    })
  })

  it('remembers the setup page so an interrupted setup resumes there', () => {
    useOnboardingGuide.getState().setSetupPage('finish')
    expect(useOnboardingGuide.getState().setupPage).toBe('finish')
  })
})
