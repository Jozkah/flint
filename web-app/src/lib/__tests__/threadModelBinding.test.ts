import { describe, expect, it } from 'vitest'
import { bindingProblem, boundProvider, boundProviderOff } from '../threadModelBinding'

const providers = [
  { provider: 'v100b', active: false },
  { provider: 'qa401', active: true },
]
const lookup = (name: string) => providers.find((p) => p.provider === name)
const bound = { id: 'swift15', provider: 'v100b' }

describe('threadModelBinding', () => {
  it('a chat with a model is bound to its provider; a new one is not', () => {
    expect(boundProvider(bound)).toBe('v100b')
    expect(boundProvider(undefined)).toBeNull()
    expect(boundProvider({ id: '', provider: 'v100b' })).toBeNull()
  })

  it('sees a provider that is switched off', () => {
    expect(boundProviderOff(bound, lookup)).toBe('v100b')
    expect(boundProviderOff({ id: 'x', provider: 'qa401' }, lookup)).toBeNull()
    // Removed altogether is the model-replace case, not this one.
    expect(boundProviderOff({ id: 'x', provider: 'gone' }, lookup)).toBeNull()
  })

  it('refuses another provider serving the same model id', () => {
    expect(bindingProblem(bound, 'qa401', lookup)).toEqual({
      reason: 'provider-off',
      provider: 'v100b',
    })
    const on = (name: string) => ({ provider: name, active: true })
    expect(bindingProblem(bound, 'qa401', on)).toEqual({
      reason: 'other-provider',
      provider: 'v100b',
      selected: 'qa401',
    })
    expect(bindingProblem(bound, 'v100b', on)).toBeNull()
    expect(bindingProblem(undefined, 'qa401', on)).toBeNull()
  })
})
