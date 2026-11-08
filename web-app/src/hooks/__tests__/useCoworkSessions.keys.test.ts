import { describe, expect, it } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

/**
 * The store is assembled from slices; its state keys, their order, and the
 * persist options must stay what they were when it was one object literal.
 */
describe('useCoworkSessions state shape', () => {
  it('keeps every key, in order', () => {
    expect(Object.keys(useCoworkSessions.getState())).toEqual([
      'sessions',
      'currentId',
      'createSession',
      'startSession',
      'startSessionParked',
      'selectSession',
      'forkSession',
      'createFromTurns',
      'dismissHandoff',
      'importSession',
      'restoreSession',
      'deleteSession',
      'setModel',
      'setPendingInput',
      'setFolder',
      'addExtraFolder',
      'removeExtraFolder',
      'setExtraFolderWritable',
      'setMainFolderReadOnly',
      'setMessages',
      'setGoal',
      'setTodos',
      'setProgressUi',
      'setAccess',
      'grantEditConsent',
      'setContinuity',
      'setRunBudget',
      'setInFlight',
      'recoverInFlight',
      'setMode',
      'setCodePanel',
      'setTitle',
      'setCampaign',
      'commitTurns',
      'appendTurns',
      'rewindToLastUser',
    ])
  })

  it('makes every action a function', () => {
    const state = useCoworkSessions.getState() as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(state)) {
      if (key === 'sessions' || key === 'currentId') continue
      expect(typeof value, key).toBe('function')
    }
  })

  it('keeps the persist options', () => {
    const options = useCoworkSessions.persist.getOptions()
    expect(options.version).toBe(5)
    expect(options.skipHydration).toBe(true)
    expect(typeof options.migrate).toBe('function')
    expect(typeof options.merge).toBe('function')
    expect(typeof options.partialize).toBe('function')
  })
})
