import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkProfiles } from '../useWorkProfiles'
import { coworkWebSearchScope, useWebSearchChoice } from '../useWebSearchChoice'

describe('dropScope', () => {
  beforeEach(() => {
    useWorkProfiles.setState({ sessions: {} })
    useWebSearchChoice.setState({ byScope: {} })
  })

  it('useWorkProfiles forgets one session and keeps the rest', () => {
    useWorkProfiles.getState().choose('a', 'execute', true)
    useWorkProfiles.getState().choose('b', 'review', false)
    useWorkProfiles.getState().dropScope('a')
    expect(Object.keys(useWorkProfiles.getState().sessions)).toEqual(['b'])
  })

  it('useWorkProfiles keeps the same state object for an unknown id', () => {
    const before = useWorkProfiles.getState().sessions
    useWorkProfiles.getState().dropScope('nope')
    expect(useWorkProfiles.getState().sessions).toBe(before)
  })

  it('useWebSearchChoice forgets one scope and keeps the rest', () => {
    useWebSearchChoice.getState().set('t1', true)
    useWebSearchChoice.getState().set(coworkWebSearchScope('s1'), false)
    useWebSearchChoice.getState().dropScope(coworkWebSearchScope('s1'))
    expect(useWebSearchChoice.getState().byScope).toEqual({ t1: true })
  })

  it('useWebSearchChoice keeps the same state object for an unknown scope', () => {
    const before = useWebSearchChoice.getState().byScope
    useWebSearchChoice.getState().dropScope('nope')
    expect(useWebSearchChoice.getState().byScope).toBe(before)
  })
})
