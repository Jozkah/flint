import { describe, it, expect } from 'vitest'
import {
  classifyTranslateError,
  cleanTranslation,
  describeFailure,
  summarizeProviderBody,
} from '../translateError'

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

describe('describeFailure', () => {
  it('keeps a plain message', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom')
  })
  it('names the status of an HTML 502 with no message', () => {
    const e = {
      message: '',
      statusCode: 502,
      responseBody:
        '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>',
    }
    expect(describeFailure(e)).toBe('502 Bad Gateway')
  })
  it('shows only the status for an empty body', () => {
    expect(describeFailure({ statusCode: 503, responseBody: '' })).toBe(
      'HTTP 503'
    )
  })
  it('strips an HTML message and prefixes the status', () => {
    expect(
      describeFailure({ message: '<html><body>Gateway down</body></html>', status: 502 })
    ).toBe('HTTP 502: Gateway down')
  })
  it('finds the status inside a wrapped error', () => {
    expect(describeFailure({ error: { statusCode: 500, responseBody: 'oops' } })).toBe(
      'HTTP 500: oops'
    )
  })
  it('is empty when there is nothing', () => {
    expect(describeFailure({})).toBe('')
  })
  it('cuts a long body', () => {
    expect(summarizeProviderBody('x'.repeat(500)).length).toBe(160)
  })
})

describe('cleanTranslation', () => {
  it('drops leading blank lines but keeps inner formatting', () => {
    expect(cleanTranslation('\n\nHola\n\n  mundo\n')).toBe('Hola\n\n  mundo\n')
    expect(cleanTranslation('\n\nHola\n', true)).toBe('Hola')
  })
  it('removes closed and still-open reasoning blocks', () => {
    expect(cleanTranslation('<think>hmm</think>\n\nHola')).toBe('Hola')
    expect(cleanTranslation('<think>hmm so far')).toBe('')
  })
})
