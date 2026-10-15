import { describe, expect, it } from 'vitest'
import {
  matchesAllWords,
  mergeById,
  pinQueryMatches,
  searchVariants,
} from '../huggingfaceSearch'

describe('searchVariants', () => {
  it('adds the hyphenated spelling of a multi-word query', () => {
    expect(searchVariants('ornith 1.5 9b')).toEqual([
      'ornith 1.5 9b',
      'ornith-1.5-9b',
    ])
  })

  it('leaves a single word or an owner/name alone', () => {
    expect(searchVariants('llama')).toEqual(['llama'])
    expect(searchVariants('acme/Ornith-1.5-9B')).toEqual(['acme/Ornith-1.5-9B'])
  })
})

describe('matchesAllWords', () => {
  it('ignores separators and case', () => {
    expect(matchesAllWords('acme/Ornith-1.5-9B-GGUF', 'ornith 1.5 9b')).toBe(true)
    expect(matchesAllWords('acme/ornith_1.5_9b', 'Ornith 1.5 9B')).toBe(true)
  })

  it('needs every word', () => {
    expect(matchesAllWords('acme/Ornith-1.0-9B', 'ornith 1.5 9b')).toBe(false)
  })
})

describe('pinQueryMatches', () => {
  it('moves matches ahead without reordering within a group', () => {
    const models = [
      { id: 'a/Old-7B' },
      { id: 'b/Ornith-1.0-9B' },
      { id: 'c/Ornith-1.5-9B-GGUF' },
      { id: 'd/ornith-1.5-9b' },
    ]
    expect(pinQueryMatches(models, 'ornith 1.5 9b').map((m) => m.id)).toEqual([
      'c/Ornith-1.5-9B-GGUF',
      'd/ornith-1.5-9b',
      'a/Old-7B',
      'b/Ornith-1.0-9B',
    ])
  })

  it('changes nothing for an empty query or when nothing matches', () => {
    const models = [{ id: 'a/x' }, { id: 'b/y' }]
    expect(pinQueryMatches(models, '')).toBe(models)
    expect(pinQueryMatches(models, 'zzz')).toBe(models)
  })
})

describe('mergeById', () => {
  it('keeps the first copy of each repository', () => {
    expect(
      mergeById([[{ id: 'a', n: 1 }], [{ id: 'a', n: 2 }, { id: 'b', n: 3 }]])
    ).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 3 }])
  })
})
