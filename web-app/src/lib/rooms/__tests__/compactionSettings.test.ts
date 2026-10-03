import { describe, it, expect } from 'vitest'
import { roomCompactionSettingsFor } from '../compactionSettings'
import { defaultProviders, providerLookup } from './helpers'

const lookup = providerLookup(defaultProviders())
const ref = { provider: 'provider-a', id: 'model-1' }

describe('roomCompactionSettingsFor', () => {
  it('follows the policy: on by default, off when auto is off', () => {
    expect(roomCompactionSettingsFor(ref, lookup, { auto: true }).enabled).toBe(true)
    expect(roomCompactionSettingsFor(ref, lookup, { auto: false }).enabled).toBe(false)
  })

  it('writes no summary under the trim strategy, as Chat does', () => {
    expect(roomCompactionSettingsFor(ref, lookup, { auto: true, strategy: 'trim' }).enabled).toBe(false)
    expect(roomCompactionSettingsFor(ref, lookup, { auto: true, strategy: 'summarize' }).enabled).toBe(true)
  })

  it('carries the policy summary size', () => {
    expect(roomCompactionSettingsFor(ref, lookup, { auto: true, summaryMaxTokens: 700 }).summaryMaxTokens).toBe(700)
    expect(roomCompactionSettingsFor(ref, lookup, { auto: true }).summaryMaxTokens).toBeUndefined()
  })
})
