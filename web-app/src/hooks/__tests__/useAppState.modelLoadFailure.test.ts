import { describe, it, expect, beforeEach } from 'vitest'
import { useAppState } from '../useAppState'

describe('model load failures', () => {
  beforeEach(() => {
    useAppState.setState({ loadingModels: {}, modelLoadFailures: {} })
  })

  it('stamps a failure for a thread and clears it', () => {
    useAppState.getState().markThreadModelLoadFailed('t1', true)
    expect(useAppState.getState().modelLoadFailures.t1).toBeTypeOf('number')
    useAppState.getState().markThreadModelLoadFailed('t1', false)
    expect(useAppState.getState().modelLoadFailures.t1).toBeUndefined()
  })

  it('clears the failure when that thread starts loading again', () => {
    useAppState.getState().markThreadModelLoadFailed('t1', true)
    useAppState.getState().markThreadModelLoadFailed('t2', true)
    useAppState.getState().updateThreadLoadingModel('t1', true)
    expect(useAppState.getState().modelLoadFailures.t1).toBeUndefined()
    expect(useAppState.getState().modelLoadFailures.t2).toBeTypeOf('number')
  })
})
