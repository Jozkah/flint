import { beforeEach, describe, expect, it } from 'vitest'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import {
  FIRST_ATTEMPT_LIMIT,
  archiveFirstAttempt,
  archivedFirstAttempt,
} from '../firstAttemptArchive'

describe('first attempt archive', () => {
  beforeEach(() => localStorage.clear())

  it('keeps a recorded first attempt after the runtime store is cleared (reload)', () => {
    useToolCallRuntime
      .getState()
      .recordFirstAttempt('call-1', { output: 'open NUL: denied', isError: true })
    useToolCallRuntime.setState({ firstAttempts: {} })
    expect(archivedFirstAttempt('call-1')).toEqual({
      output: 'open NUL: denied',
      isError: true,
    })
  })

  it('keeps only the newest entries', () => {
    for (let i = 0; i <= FIRST_ATTEMPT_LIMIT; i++) {
      archiveFirstAttempt(`c${i}`, { output: 'x', isError: true })
    }
    expect(archivedFirstAttempt('c0')).toBeUndefined()
    expect(archivedFirstAttempt(`c${FIRST_ATTEMPT_LIMIT}`)).toBeDefined()
  })
})
