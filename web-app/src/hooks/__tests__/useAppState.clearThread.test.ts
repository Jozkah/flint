import { describe, expect, it } from 'vitest'
import { useAppState } from '../useAppState'

describe('useAppState.clearThreadState', () => {
  it('drops the model load failure count of the thread', () => {
    useAppState.setState({ modelLoadFailures: { t1: 2, t2: 1 } })
    useAppState.getState().clearThreadState('t1')
    expect(useAppState.getState().modelLoadFailures).toEqual({ t2: 1 })
  })

  it('drops the abort controller of the thread', () => {
    const keep = new AbortController()
    useAppState.setState({
      abortControllers: { t1: new AbortController(), t2: keep },
    })
    useAppState.getState().clearThreadState('t1')
    expect(useAppState.getState().abortControllers).toEqual({ t2: keep })
  })
})
