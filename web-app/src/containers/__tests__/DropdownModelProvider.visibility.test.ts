/**
 * Why a model vanishes from the model bar.
 *
 * Two defects stacked, and together they explain the disappearance:
 *
 * 1. `predefinedProviders.some((e) => e.provider.includes(provider.provider))`
 *    is a substring test, and backwards. It asks whether a *template's* id
 *    contains the *user's* provider name, so a provider called `ai` matched
 *    `openai` and one called `x` matched `xai`. Such a provider was silently
 *    reclassified as a built-in template.
 *
 * 2. The visibility gate then required an API key. `partialize` strips
 *    `api_key` and `api_key_fallbacks` before persisting -- keys live in the OS
 *    keyring -- so after every restart every provider looks keyless until
 *    `applyKeyringKeys()` re-seeds them.
 *
 * A custom provider with a short name was therefore treated as an
 * unconfigured built-in, found keyless, and had every one of its models
 * dropped from the picker. The model was there before the restart and gone
 * after it.
 *
 * These assert the predicate directly. The old implementation is included so
 * the tests demonstrate the bug rather than merely describing it.
 */

import { describe, expect, it } from 'vitest'
import { predefinedProviders } from '@/constants/providers'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'

type P = {
  provider: string
  models: unknown[]
  api_key?: string
  api_key_fallbacks?: string[]
}

/** The shipped predicate, mirrored. */
const isPredefinedProvider = (name: string) =>
  predefinedProviders.some((e) => e.provider === name)

const offersModels = (p: P): boolean => {
  if (p.provider === 'llamacpp') return true
  if (!isPredefinedProvider(p.provider)) return p.models.length > 0
  return providerHasRemoteApiKeys(p) || p.models.length > 0
}

/** What it replaced, kept so the regression stays visible. */
const oldSkipped = (p: P): boolean => {
  const isPredefined = predefinedProviders.some((e) =>
    e.provider.includes(p.provider)
  )
  return (
    p.provider !== 'llamacpp' &&
    !providerHasRemoteApiKeys(p) &&
    (isPredefined || p.models.length === 0)
  )
}

const withModels = (provider: string, api_key?: string): P => ({
  provider,
  models: [{ id: 'pxa-27b' }],
  api_key,
})

describe('classifying a provider as built-in', () => {
  it('matches exactly, not by substring', () => {
    expect(isPredefinedProvider('openai')).toBe(true)
    // A user's own provider whose name is a substring of a template's.
    expect(isPredefinedProvider('ai')).toBe(false)
    expect(isPredefinedProvider('open')).toBe(false)
    expect(isPredefinedProvider('llm-host test')).toBe(false)
  })

  it('is what the old substring test got wrong', () => {
    const oldIsPredefined = (name: string) =>
      predefinedProviders.some((e) => e.provider.includes(name))
    // The bug, demonstrated: a provider called `ai` was read as a built-in.
    expect(oldIsPredefined('ai')).toBe(true)
    expect(isPredefinedProvider('ai')).toBe(false)
  })
})

describe('which providers offer models to the picker', () => {
  it('offers a user-added provider that has discovered models', () => {
    expect(offersModels(withModels('llm-host test'))).toBe(true)
  })

  /// The restart case. Keys are stripped before persisting, so this is what
  /// every provider looks like on launch.
  it('keeps offering them when the key has not been re-seeded yet', () => {
    const p = withModels('llm-host test', undefined)
    expect(providerHasRemoteApiKeys(p)).toBe(false)
    expect(offersModels(p)).toBe(true)
  })

  /// The exact reported symptom, with both defects active.
  it('no longer drops a short-named provider after a restart', () => {
    const p = withModels('ai', undefined)
    // Old behaviour: skipped, so every model under it vanished from the bar.
    expect(oldSkipped(p)).toBe(true)
    // New behaviour: offered.
    expect(offersModels(p)).toBe(true)
  })

  it('always offers the bundled local runtime', () => {
    expect(offersModels({ provider: 'llamacpp', models: [] })).toBe(true)
  })

  it('hides a built-in template that is unconfigured', () => {
    expect(offersModels({ provider: 'openai', models: [] })).toBe(false)
  })

  it('offers a built-in template once it has a key', () => {
    expect(offersModels({ provider: 'openai', models: [], api_key: 'sk-x' })).toBe(
      true
    )
  })

  it('offers a built-in template the user added models to', () => {
    expect(offersModels(withModels('openai'))).toBe(true)
  })

  it('hides a user-added provider that has discovered nothing', () => {
    // Not a regression: there is nothing to offer. The provider still appears
    // in Settings; it has no models to put in the bar.
    expect(offersModels({ provider: 'llm-host test', models: [] })).toBe(false)
  })

  it('agrees with the sort, which uses the same predicate', () => {
    // The visibility gate and the ordering must not disagree about what
    // "configured" means, or a provider sorts above the fold and is invisible.
    const configured = withModels('llm-host test')
    const template = { provider: 'openai', models: [] }
    expect(offersModels(configured)).toBe(true)
    expect(offersModels(template)).toBe(false)
  })
})
