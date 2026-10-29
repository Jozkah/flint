import { describe, expect, it } from 'vitest'
import {
  buildDisambiguation,
  buildPickerGroups,
  buildSearchableItems,
  filterBySearch,
  findAmbiguousModelIds,
  hostOf,
  isFavoriteItem,
  locationKind,
  remoteLabelFor,
} from '../modelPickerItems'
import { VOICE_MODEL_ID } from '@/lib/voice/voiceModel'

const prov = (
  provider: string,
  models: Partial<Model>[],
  extra: Partial<ModelProvider> = {}
): ModelProvider =>
  ({
    provider,
    active: true,
    api_key: 'k',
    base_url: `https://${provider}.example.com/v1`,
    settings: [],
    models: models.map((m) => ({ id: 'x', ...m })),
    ...extra,
  }) as unknown as ModelProvider

const noHide = () => false

describe('hostOf', () => {
  it('returns host with port, or empty', () => {
    expect(hostOf('http://api.example.com:8080/v1')).toBe('api.example.com:8080')
    expect(hostOf(undefined)).toBe('')
    expect(hostOf('not a url')).toBe('')
  })
})

describe('locationKind', () => {
  it('local for built-in engine and loopback, remote for public host', () => {
    expect(locationKind(prov('llamacpp', [], { base_url: undefined }))).toBe('local')
    expect(locationKind(prov('x', [], { base_url: 'http://127.0.0.1:1234' }))).toBe('local')
    expect(locationKind(prov('openai', []))).toBe('remote')
  })
})

describe('buildSearchableItems', () => {
  it('skips inactive providers, embedding and voice models', () => {
    const items = buildSearchableItems(
      [
        prov('openai', [
          { id: 'gpt-4o', capabilities: ['vision'] },
          { id: 'embed', embedding: true },
          { id: VOICE_MODEL_ID },
        ]),
        prov('off', [{ id: 'm' }], { active: false }),
      ],
      { hideProvider: noHide, selectedProvider: '' }
    )
    expect(items.map((i) => i.value)).toEqual(['openai:gpt-4o'])
    expect(items[0].searchStr).toContain('gpt-4o')
    expect(items[0].searchStr).toContain('vision')
  })

  it('a hidden provider keeps only the selected model', () => {
    const items = buildSearchableItems(
      [prov('openai', [{ id: 'a' }, { id: 'b' }])],
      {
        hideProvider: () => true,
        selectedProvider: 'openai',
        selectedModelId: 'b',
      }
    )
    expect(items.map((i) => i.model.id)).toEqual(['b'])
  })
})

describe('ambiguity and labels', () => {
  const items = buildSearchableItems(
    [
      prov('openai', [{ id: 'gpt-4o' }]),
      prov('work', [{ id: 'gpt-4o' }, { id: 'other' }]),
    ],
    { hideProvider: noHide, selectedProvider: '' }
  )

  it('flags ids offered by two providers', () => {
    expect([...findAmbiguousModelIds(items)]).toEqual(['gpt-4o'])
  })

  it('remote label is the title when unique', () => {
    expect(remoteLabelFor(items, items[0].provider)).not.toContain('·')
  })

  it('disambiguation keys are item values', () => {
    const d = buildDisambiguation(
      buildSearchableItems(
        [
          prov('llamacpp', [
            { id: 'Qwen3-8B-Q4_K_M' },
            { id: 'Qwen3-8B-Q8_0' },
          ]),
        ],
        { hideProvider: noHide, selectedProvider: '' }
      )
    )
    for (const key of d.keys()) expect(key.startsWith('llamacpp:')).toBe(true)
  })
})

describe('filterBySearch', () => {
  const items = buildSearchableItems(
    [
      prov('openai', [{ id: 'gpt-4o' }, { id: 'gemini-pro-turbo' }]),
      prov('work', [{ id: 'gpt-4o' }]),
    ],
    { hideProvider: noHide, selectedProvider: '' }
  )

  it('empty search returns the same list', () => {
    expect(filterBySearch(items, '')).toBe(items)
  })

  it('each word must appear verbatim, no fuzzy subsequence', () => {
    expect(filterBySearch(items, 'gpt').map((i) => i.value)).toEqual([
      'openai:gpt-4o',
      'work:gpt-4o',
    ])
  })

  it('a word can match the remote', () => {
    expect(filterBySearch(items, 'gpt-4o work').map((i) => i.value)).toEqual([
      'work:gpt-4o',
    ])
  })
})

describe('buildPickerGroups', () => {
  const providers = [
    prov('zeta', [{ id: 'z' }]),
    prov('llamacpp', [{ id: 'b-local' }, { id: 'a-local' }], {
      base_url: undefined,
    }),
    prov('alpha', [{ id: 'a' }], { base_url: 'https://down.example.com' }),
  ]
  const items = buildSearchableItems(providers, {
    hideProvider: noHide,
    selectedProvider: '',
  })
  const base = {
    filteredItems: items,
    providers,
    searchValue: '',
    favoriteModels: [] as never[],
    unreachableOrigins: {},
    hideProvider: noHide,
    selectedProvider: '',
  }

  it('local first, then by name; models sorted by name', () => {
    const groups = buildPickerGroups(base)
    expect(Object.keys(groups)).toEqual(['llamacpp', 'alpha', 'zeta'])
    expect(groups.llamacpp.map((i) => i.model.id)).toEqual([
      'a-local',
      'b-local',
    ])
  })

  it('unreachable providers go last', () => {
    const groups = buildPickerGroups({
      ...base,
      unreachableOrigins: { 'https://down.example.com': { at: 1 } },
    })
    expect(Object.keys(groups)).toEqual(['llamacpp', 'zeta', 'alpha'])
  })

  it('favourites are left out of sections unless searching', () => {
    const fav = [{ id: 'z', provider: 'zeta' }] as never[]
    expect(isFavoriteItem(fav, items.find((i) => i.model.id === 'z')!)).toBe(
      true
    )
    expect(buildPickerGroups({ ...base, favoriteModels: fav }).zeta).toEqual([])
    const searching = buildPickerGroups({
      ...base,
      favoriteModels: fav,
      searchValue: 'z',
      filteredItems: filterBySearch(items, 'z'),
    })
    expect(searching.zeta.map((i) => i.model.id)).toEqual(['z'])
  })

  it('while searching only providers with matches appear', () => {
    const groups = buildPickerGroups({
      ...base,
      searchValue: 'a-local',
      filteredItems: filterBySearch(items, 'a-local'),
    })
    expect(Object.keys(groups)).toEqual(['llamacpp'])
  })

  it('hidden providers keep no empty section, except the selected one', () => {
    const hide = (p: ModelProvider) => p.provider === 'zeta'
    expect(
      Object.keys(buildPickerGroups({ ...base, filteredItems: [], hideProvider: hide }))
    ).toEqual(['llamacpp', 'alpha'])
    expect(
      Object.keys(
        buildPickerGroups({
          ...base,
          filteredItems: [],
          hideProvider: hide,
          selectedProvider: 'zeta',
        })
      )
    ).toContain('zeta')
  })
})
