import { describe, it, expect } from 'vitest'
import { keyringKeysToApply } from '../provider-api-keys'

describe('keyringKeysToApply', () => {
  it('fills a provider that has no key in memory (after a reload)', () => {
    expect(
      keyringKeysToApply({ api_key: '' }, { api_key: 'sk-real', api_key_fallbacks: ['b'] })
    ).toEqual({ api_key: 'sk-real', api_key_fallbacks: ['b'] })
    expect(keyringKeysToApply(undefined, { api_key: 'sk-real' })).toEqual({
      api_key: 'sk-real',
      api_key_fallbacks: undefined,
    })
  })

  it('never puts an older stored key over the one the user just typed', () => {
    expect(keyringKeysToApply({ api_key: 'typed' }, { api_key: 'x' })).toBeNull()
  })

  it('does nothing when the keyring holds nothing', () => {
    expect(keyringKeysToApply({ api_key: '' }, {})).toBeNull()
  })
})
