import { describe, expect, it } from 'vitest'
import { groupBySource, type ScannedModel } from '@/lib/localModelScan'

const model = (name: string, source: string): ScannedModel => ({
  path: `/m/${name}`,
  name,
  source,
  size_bytes: 1,
})

describe('groupBySource', () => {
  it('groups models under the app they came from, in first-seen order', () => {
    const groups = groupBySource([
      model('a', 'Ollama'),
      model('b', 'LM Studio'),
      model('c', 'Ollama'),
    ])
    expect(groups.map((g) => g.source)).toEqual(['Ollama', 'LM Studio'])
    expect(groups[0].models.map((m) => m.name)).toEqual(['a', 'c'])
  })

  it('returns nothing for an empty scan', () => {
    expect(groupBySource([])).toEqual([])
  })
})
