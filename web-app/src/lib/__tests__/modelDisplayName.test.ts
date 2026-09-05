import { describe, expect, it } from 'vitest'
import {
  normalizeDisplayName,
  takenNames,
  validateDisplayName,
} from '@/lib/modelDisplayName'

const model = (id: string, displayName?: string): Model =>
  ({ id, ...(displayName === undefined ? {} : { displayName }) }) as Model

/** A provider offering three models, one of them already renamed. */
const models = [
  model('gpt-5'),
  model('gpt-5-mini', 'Fast one'),
  model('o3-pro'),
]

describe('naming a model', () => {
  it('stores the name with its surrounding space removed', () => {
    const result = validateDisplayName({
      raw: '  Daily driver  ',
      modelId: 'gpt-5',
      models,
    })
    expect(result).toEqual({ ok: true, displayName: 'Daily driver' })
  })

  it('collapses runs of whitespace, so two names cannot look alike', () => {
    expect(normalizeDisplayName('Daily   driver')).toBe('Daily driver')
    expect(normalizeDisplayName('Daily\tdriver')).toBe('Daily driver')
  })

  it('refuses a name that differs from another only by case', () => {
    // Case is not what distinguishes two rows in a list.
    expect(
      validateDisplayName({ raw: 'FAST ONE', modelId: 'gpt-5', models })
    ).toEqual({ ok: false, error: 'duplicate' })
  })
})

describe('rejecting a name', () => {
  it('refuses an empty one', () => {
    expect(
      validateDisplayName({ raw: '', modelId: 'gpt-5', models })
    ).toEqual({ ok: false, error: 'empty' })
  })

  it('refuses one that is only whitespace', () => {
    expect(
      validateDisplayName({ raw: '   \t ', modelId: 'gpt-5', models })
    ).toEqual({ ok: false, error: 'empty' })
  })

  it('refuses a name another model already answers to', () => {
    expect(
      validateDisplayName({ raw: 'Fast one', modelId: 'gpt-5', models })
    ).toEqual({ ok: false, error: 'duplicate' })
  })

  it('refuses a name that impersonates another model’s identifier', () => {
    // Worse than a duplicate: the row would claim to be a model it is not.
    expect(
      validateDisplayName({ raw: 'o3-pro', modelId: 'gpt-5', models })
    ).toEqual({ ok: false, error: 'duplicate' })
  })

  it('does not treat a model’s own current name as a clash', () => {
    // Re-saving the dialog without touching the field must work.
    expect(
      validateDisplayName({ raw: 'Fast one', modelId: 'gpt-5-mini', models })
    ).toEqual({ ok: true, displayName: 'Fast one' })
  })
})

describe('giving a model its own name back', () => {
  it('stores no override when the identifier is typed in', () => {
    // Not "renamed to its id" — the override is gone, so the model follows
    // whatever the provider calls it from then on.
    expect(
      validateDisplayName({ raw: 'gpt-5-mini', modelId: 'gpt-5-mini', models })
    ).toEqual({ ok: true, displayName: undefined })
  })
})

describe('what a rename may not collide with', () => {
  it('lists every other model’s name and identifier, lowercased', () => {
    expect(takenNames(models, 'gpt-5')).toEqual(
      new Set(['fast one', 'gpt-5-mini', 'o3-pro'])
    )
  })

  it('excludes the model being renamed, by identifier', () => {
    expect(takenNames(models, 'gpt-5-mini').has('fast one')).toBe(false)
    expect(takenNames(models, 'gpt-5-mini').has('gpt-5-mini')).toBe(false)
  })

  it('is empty for a provider with a single model', () => {
    expect(takenNames([model('solo')], 'solo').size).toBe(0)
  })
})
