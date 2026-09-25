import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_SORT,
  isModelSortOption,
  lastUsedAt,
  modelUsageKey,
  sortModels,
  type SortableModel,
} from '@/lib/modelSort'

const item = (
  providerName: string,
  id: string,
  displayName?: string
): SortableModel => ({
  provider: { provider: providerName },
  model: {
    id,
    ...(displayName === undefined ? {} : { displayName }),
  } as Model,
})

const names = (items: SortableModel[]) =>
  items.map((i) => i.model.displayName ?? i.model.id)

describe('the default order', () => {
  it('groups by provider, the design picker', () => {
    expect(DEFAULT_MODEL_SORT).toBe('provider')
  })

  it('sorts alphabetically by the name the user sees when asked', () => {
    const sorted = sortModels(
      [
        item('openai', 'gpt-5', 'Zephyr'),
        item('openai', 'o3', 'Anvil'),
        item('anthropic', 'claude', 'Meridian'),
      ],
      'name-asc'
    )
    expect(names(sorted)).toEqual(['Anvil', 'Meridian', 'Zephyr'])
  })

  it('orders a renamed model by its new name, not its identifier', () => {
    // 'zzz-model' renamed to 'Aardvark' belongs first, or the rename would be
    // cosmetic only.
    const sorted = sortModels(
      [item('openai', 'bbb-model'), item('openai', 'zzz-model', 'Aardvark')],
      'name-asc'
    )
    expect(names(sorted)).toEqual(['Aardvark', 'bbb-model'])
  })

  it('ignores case', () => {
    const sorted = sortModels(
      [item('p', 'b', 'beta'), item('p', 'a', 'Alpha')],
      'name-asc'
    )
    expect(names(sorted)).toEqual(['Alpha', 'beta'])
  })

  it('reads embedded numbers as numbers', () => {
    const sorted = sortModels(
      [item('p', 'llama-70b'), item('p', 'llama-9b')],
      'name-asc'
    )
    expect(names(sorted)).toEqual(['llama-9b', 'llama-70b'])
  })

  it('breaks ties on identifier, so the order never depends on input order', () => {
    const forward = sortModels(
      [item('p', 'b-id', 'Same'), item('p', 'a-id', 'Same')],
      'name-asc'
    )
    const backward = sortModels(
      [item('p', 'a-id', 'Same'), item('p', 'b-id', 'Same')],
      'name-asc'
    )
    expect(forward.map((i) => i.model.id)).toEqual(['a-id', 'b-id'])
    expect(backward.map((i) => i.model.id)).toEqual(['a-id', 'b-id'])
  })

  it('leaves the list it was given untouched', () => {
    const input = [item('p', 'b', 'Beta'), item('p', 'a', 'Alpha')]
    const sorted = sortModels(input, 'name-asc')
    expect(names(input)).toEqual(['Beta', 'Alpha'])
    expect(sorted).not.toBe(input)
  })
})

describe('reverse alphabetical', () => {
  it('is the default order backwards', () => {
    const sorted = sortModels(
      [
        item('p', 'a', 'Anvil'),
        item('p', 'z', 'Zephyr'),
        item('p', 'm', 'Meridian'),
      ],
      'name-desc'
    )
    expect(names(sorted)).toEqual(['Zephyr', 'Meridian', 'Anvil'])
  })
})

describe('recently used', () => {
  const models = [
    item('openai', 'gpt-5', 'Zephyr'),
    item('openai', 'o3', 'Anvil'),
    item('anthropic', 'claude', 'Meridian'),
  ]

  it('puts the most recently picked model first', () => {
    const sorted = sortModels(models, 'recent', {
      'openai:gpt-5': 100,
      'anthropic:claude': 300,
      'openai:o3': 200,
    })
    expect(names(sorted)).toEqual(['Meridian', 'Anvil', 'Zephyr'])
  })

  it('keys usage by provider as well as identifier', () => {
    // The same model id served by two providers is two different entries.
    expect(modelUsageKey('openai', 'gpt-5')).toBe('openai:gpt-5')
    const sorted = sortModels(
      [item('openai', 'shared', 'A'), item('azure', 'shared', 'B')],
      'recent',
      { 'azure:shared': 50 }
    )
    expect(names(sorted)).toEqual(['B', 'A'])
  })

  it('sends never-used models to the end, in alphabetical order', () => {
    const sorted = sortModels(models, 'recent', { 'openai:gpt-5': 100 })
    expect(names(sorted)).toEqual(['Zephyr', 'Anvil', 'Meridian'])
  })

  it('falls back to alphabetical when nothing has been used', () => {
    expect(names(sortModels(models, 'recent', {}))).toEqual([
      'Anvil',
      'Meridian',
      'Zephyr',
    ])
    expect(names(sortModels(models, 'recent'))).toEqual([
      'Anvil',
      'Meridian',
      'Zephyr',
    ])
  })

  it('reports zero for a model with no recorded use', () => {
    expect(lastUsedAt({ 'openai:gpt-5': 7 }, models[0])).toBe(7)
    expect(lastUsedAt({}, models[0])).toBe(0)
    expect(lastUsedAt(undefined, models[0])).toBe(0)
  })
})

describe('by provider', () => {
  it('groups a provider’s models together, each group alphabetical', () => {
    const sorted = sortModels(
      [
        item('openai', 'gpt-5', 'Zephyr'),
        item('anthropic', 'opus', 'Beta'),
        item('openai', 'o3', 'Anvil'),
        item('anthropic', 'sonnet', 'Alpha'),
      ],
      'provider'
    )
    expect(sorted.map((i) => i.provider.provider)).toEqual([
      'anthropic',
      'anthropic',
      'openai',
      'openai',
    ])
    expect(names(sorted)).toEqual(['Alpha', 'Beta', 'Anvil', 'Zephyr'])
  })
})

describe('the stored preference', () => {
  it('recognises every option it offers, and nothing else', () => {
    expect(isModelSortOption('name-asc')).toBe(true)
    expect(isModelSortOption('name-desc')).toBe(true)
    expect(isModelSortOption('recent')).toBe(true)
    expect(isModelSortOption('provider')).toBe(true)
    expect(isModelSortOption('whatever')).toBe(false)
    expect(isModelSortOption(undefined)).toBe(false)
  })
})
