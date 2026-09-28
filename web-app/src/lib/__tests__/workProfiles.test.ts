import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

import { classifyLocally } from '../workProfiles'
import { chooseWorkProfile, useWorkProfiles } from '@/hooks/useWorkProfiles'

describe('classifyLocally', () => {
  it('reads the kind of work from the wording', () => {
    expect(classifyLocally('Please review this diff for bugs')).toBe('review')
    expect(classifyLocally('refactor the camera module into two files')).toBe('refactor')
    expect(classifyLocally('why does the drone camera crash on deploy?')).toBe('debug')
    expect(classifyLocally('plan the migration to the new SDK')).toBe('plan')
    expect(classifyLocally('reverse engineer the save file format')).toBe('reverse-engineer')
    expect(classifyLocally('add a settings toggle for the overlay')).toBe('execute')
  })
})

describe('chooseWorkProfile', () => {
  beforeEach(() => useWorkProfiles.setState({ enabled: true, overrides: {}, sessions: {} }))

  it('does nothing while work profiles are off', async () => {
    useWorkProfiles.setState({ enabled: false })
    expect(await chooseWorkProfile('s', 'review this')).toBeUndefined()
    expect(useWorkProfiles.getState().blockFor('s')).toBeUndefined()
  })

  it('uses Jev when it answers with a profile, the keyword match otherwise', async () => {
    expect(await chooseWorkProfile('s', 'review this', async () => 'plan')).toBe('plan')
    expect(await chooseWorkProfile('s', 'review this', async () => null)).toBe('review')
    expect(await chooseWorkProfile('s', 'review this', async () => 'nonsense')).toBe('review')
  })

  it('keeps a profile the user picked by hand', async () => {
    useWorkProfiles.getState().choose('s', 'debug', true)
    expect(await chooseWorkProfile('s', 'review this')).toBe('debug')
  })

  it('puts the edited text in the prompt block', async () => {
    useWorkProfiles.getState().setOverride('review', 'Only list security issues.')
    await chooseWorkProfile('s', 'review this')
    expect(useWorkProfiles.getState().blockFor('s')).toContain('Only list security issues.')
  })
})
