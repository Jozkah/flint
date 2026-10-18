import { describe, it, expect } from 'vitest'
import { classifyTranslateError } from '../translateError'

describe('classifyTranslateError', () => {
  it('maps a missing local engine to its own kind', () => {
    expect(
      classifyTranslateError(
        'Failed to start model: The llamacpp engine is not available. Restart Flint and try again.'
      )
    ).toBe('engineUnavailable')
  })

  it('keeps the other kinds', () => {
    expect(classifyTranslateError('401 Unauthorized')).toBe('auth')
    expect(classifyTranslateError('429 rate limit')).toBe('quota')
    expect(classifyTranslateError('model foo not found')).toBe('modelNotFound')
    expect(classifyTranslateError('Failed to fetch')).toBe('network')
    expect(classifyTranslateError('something odd')).toBeNull()
  })
})
