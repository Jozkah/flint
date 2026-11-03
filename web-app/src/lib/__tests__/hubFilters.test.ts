import { describe, it, expect } from 'vitest'
import {
  applyFilters,
  clearedFilters,
  defaultFilters,
  filtersActive,
  inParameterBucket,
  type HubFilterContext,
} from '../hubFilters'
import type { HuggingFaceModel } from '../huggingface'

const model = (over: Partial<HuggingFaceModel> & { id: string }): HuggingFaceModel => ({
  downloads: 0,
  likes: 0,
  gated: false,
  tags: [],
  files: [],
  ...over,
})

const ctx = (over: Partial<HubFilterContext> = {}): HubFilterContext => ({
  query: '',
  filesFor: (m) => m.files,
  isInstalled: () => false,
  fitsHardware: () => true,
  ...over,
})

describe('hubFilters', () => {
  it('buckets parameter counts', () => {
    expect(inParameterBucket(null, 'all')).toBe(true)
    expect(inParameterBucket(null, 'tiny')).toBe(false)
    expect(inParameterBucket(2, 'tiny')).toBe(true)
    expect(inParameterBucket(3, 'small')).toBe(true)
    expect(inParameterBucket(8, 'medium')).toBe(true)
    expect(inParameterBucket(70, 'large')).toBe(true)
  })

  it('reports and clears active filters but keeps the sort', () => {
    const base = defaultFilters()
    expect(filtersActive(base)).toBe(false)
    const on = { ...base, fitsOnly: true, sort: 'likes' as const }
    expect(filtersActive(on)).toBe(true)
    const cleared = clearedFilters(on)
    expect(filtersActive(cleared)).toBe(false)
    expect(cleared.sort).toBe('likes')
  })

  it('sorts by the chosen key', () => {
    const list = [
      model({ id: 'a/a', downloads: 1, likes: 9 }),
      model({ id: 'b/b', downloads: 5, likes: 1 }),
    ]
    expect(applyFilters(list, defaultFilters(), ctx()).map((m) => m.id)).toEqual([
      'b/b',
      'a/a',
    ])
    expect(
      applyFilters(list, { ...defaultFilters(), sort: 'likes' }, ctx()).map((m) => m.id)
    ).toEqual(['a/a', 'b/b'])
  })

  it('drops gated, not-installed and not-fitting repos on request', () => {
    const list = [
      model({ id: 'a/gated', gated: true }),
      model({ id: 'a/open' }),
      model({ id: 'a/big' }),
    ]
    const noGated = applyFilters(list, { ...defaultFilters(), includeGated: false }, ctx())
    expect(noGated.map((m) => m.id)).not.toContain('a/gated')
    const installed = applyFilters(
      list,
      { ...defaultFilters(), downloadedOnly: true },
      ctx({ isInstalled: (m) => m.id === 'a/open' })
    )
    expect(installed.map((m) => m.id)).toEqual(['a/open'])
    const fits = applyFilters(
      list,
      { ...defaultFilters(), fitsOnly: true },
      ctx({ fitsHardware: (m) => m.id !== 'a/big' })
    )
    expect(fits.map((m) => m.id)).not.toContain('a/big')
  })

  it('pins a pasted exact repo id first', () => {
    const list = [
      model({ id: 'x/popular-llama', downloads: 100 }),
      model({ id: 'me/llama', downloads: 1 }),
    ]
    const out = applyFilters(list, defaultFilters(), ctx({ query: 'me/llama' }))
    expect(out[0].id).toBe('me/llama')
  })
})
