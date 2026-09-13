/**
 * A persisted context size of `0` is not a context size.
 *
 * It got into settings from a provider that reported `"context_length": 0`,
 * from a control saved while empty, and from a `parseInt` of something that
 * was never a number. Downstream every one of those was read as a real
 * capacity: `0 / 0` in the indicator, no room for a single token in the
 * budget, a reply cap of zero in the request.
 *
 * Migration 19 turns them all into "not set", which is the state the rest of
 * the app already resolves properly -- discovery runs, and a window nobody can
 * discover stays explicitly unknown. A positive value is a decision somebody
 * made and is never touched, so nobody has to delete their profile to get out
 * of the broken state.
 */

import { describe, it, expect, vi } from 'vitest'
import { useModelProvider } from '../useModelProvider'

vi.mock('@/lib/fileStorage', () => ({
  fileStorage: {
    getItem: vi.fn(() => Promise.resolve(null)),
    setItem: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: vi.fn(() => ({ path: () => ({ sep: () => '/' }) })),
}))

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { modelProvider: 'jan-model-provider' },
}))

type Migrate = (state: unknown, version: number) => any

const getMigrate = (): Migrate => {
  const persistApi = (useModelProvider as any).persist
  const migrate = persistApi?.getOptions().migrate
  if (!migrate) throw new Error('the store has no migration to test')
  return migrate as Migrate
}

/** One persisted model whose `ctx_len` holds `value`. */
const stateWith = (value: unknown, provider = 'llamacpp') => ({
  providers: [
    {
      provider,
      active: true,
      settings: [],
      models: [
        {
          id: 'local-model',
          settings: {
            ctx_len: {
              key: 'ctx_len',
              title: 'Context Size',
              controller_props: { value },
            },
            // A neighbouring setting, to prove the migration touches one key.
            temperature: { key: 'temperature', controller_props: { value: 0.7 } },
          },
        },
      ],
    },
  ],
  deletedModels: [],
})

const ctxAfterMigration = (value: unknown, from = 18) => {
  const migrated = getMigrate()(stateWith(value), from)
  return migrated.providers[0].models[0].settings.ctx_len.controller_props.value
}

describe('migrating a persisted context size that is not one', () => {
  it.each([
    ['integer zero', 0],
    ['the string "0"', '0'],
    ['a negative number', -1],
    ['a negative string', '-4096'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a malformed string', 'eight thousand'],
    ['an empty-ish string', '   '],
    ['a boolean', true],
    ['an object', { value: 8192 }],
  ])('replaces %s with "not set"', (_label, value) => {
    expect(ctxAfterMigration(value)).toBe('')
  })

  it.each([
    ['a plain number', 8192, 8192],
    ['a numeric string', '32768', '32768'],
    ['a large window', 131072, 131072],
  ])('never overwrites %s', (_label, value, expected) => {
    expect(ctxAfterMigration(value)).toBe(expected)
  })

  it('leaves an already-unset control alone', () => {
    // Rewriting `''` to `''` would churn every model on every upgrade for no
    // gain, and would make the migration's own count meaningless.
    expect(ctxAfterMigration('')).toBe('')
    expect(ctxAfterMigration(null)).toBe(null)
    expect(ctxAfterMigration(undefined)).toBe(undefined)
  })

  it('repairs models under any provider, not only llamacpp', () => {
    // A zero window arrives from an OpenAI-compatible endpoint at least as
    // often as from the bundled runtime.
    const migrated = getMigrate()(
      { ...stateWith(0, 'my-local-openai-server') },
      18
    )
    expect(
      migrated.providers[0].models[0].settings.ctx_len.controller_props.value
    ).toBe('')
  })

  it('preserves every other setting on the model', () => {
    const migrated = getMigrate()(stateWith(0), 18)
    const settings = migrated.providers[0].models[0].settings
    expect(settings.temperature.controller_props.value).toBe(0.7)
    expect(migrated.providers[0].models[0].id).toBe('local-model')
    expect(migrated.providers[0].provider).toBe('llamacpp')
  })

  it('tolerates a model with no settings at all', () => {
    // Older schemas, and providers whose models were never opened.
    const state = {
      providers: [
        { provider: 'openai', active: true, settings: [], models: [{ id: 'a' }] },
        { provider: 'empty', active: true, settings: [] },
      ],
      deletedModels: [],
    }
    expect(() => getMigrate()(state, 18)).not.toThrow()
    expect(() => getMigrate()({}, 18)).not.toThrow()
    expect(() => getMigrate()({ providers: [] }, 0)).not.toThrow()
  })

  it('has already run for a profile written at the current version', () => {
    // Version 19 and later must not have the zero rewritten out from under a
    // user who has deliberately set one since.
    expect(ctxAfterMigration(0, 19)).toBe(0)
  })

  it('reports what it repaired without naming a provider', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    getMigrate()(
      {
        providers: [
          {
            provider: 'openai',
            api_key: 'sk-secret-key',
            active: true,
            settings: [],
            models: [
              { id: 'a', settings: { ctx_len: { controller_props: { value: 0 } } } },
              { id: 'b', settings: { ctx_len: { controller_props: { value: '0' } } } },
            ],
          },
        ],
        deletedModels: [],
      },
      18
    )
    expect(info).toHaveBeenCalledTimes(1)
    const line = String(info.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('2 model(s)')
    expect(line).not.toContain('sk-secret-key')
    expect(line).not.toContain('openai')
    info.mockRestore()
  })

  it('says nothing when there was nothing to repair', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    getMigrate()(stateWith(8192), 18)
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
  })
})
