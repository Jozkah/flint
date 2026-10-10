import { describe, expect, it } from 'vitest'
import { listedModelId, modelIdKey } from '../modelIdPath'

describe('modelIdPath', () => {
  it('reads backslash and slash ids as the same model', () => {
    expect(modelIdKey('a\\b\\c.Q5')).toBe('a/b/c.Q5')
    expect(modelIdKey('a/b/c.Q5')).toBe('a/b/c.Q5')
  })

  it('returns the id the provider lists', () => {
    const models = [{ id: 'a\\b\\c.Q5' }, { id: 'x/y' }]
    expect(listedModelId(models, 'a/b/c.Q5')).toBe('a\\b\\c.Q5')
    expect(listedModelId(models, 'x/y')).toBe('x/y')
    expect(listedModelId(models, 'nope')).toBe('nope')
    expect(listedModelId(undefined, 'nope')).toBe('nope')
  })
})
