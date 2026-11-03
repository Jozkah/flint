import { describe, it, expect } from 'vitest'
import { buildModelRows, filterModelRows } from '../modelTableRows'

const provider = (name: string, active: boolean, ids: string[]) => ({
  provider: name,
  active,
  models: ids.map((id) => ({ id, name: id.toUpperCase() })),
})

describe('modelTableRows', () => {
  const rows = buildModelRows([
    provider('llamacpp', true, ['qwen', 'llama']),
    provider('openai', true, ['gpt']),
    provider('mlx', false, ['hidden']),
  ])

  it('lists the models of enabled providers and marks the ones that run here', () => {
    expect(rows.map((r) => r.model.id)).toEqual(['qwen', 'llama', 'gpt'])
    expect(rows.map((r) => r.local)).toEqual([true, true, false])
  })

  it('filters by where it runs', () => {
    expect(filterModelRows(rows, 'local', '').map((r) => r.model.id)).toEqual([
      'qwen',
      'llama',
    ])
    expect(filterModelRows(rows, 'remote', '').map((r) => r.model.id)).toEqual([
      'gpt',
    ])
  })

  it('matches the query against id, name and provider title', () => {
    expect(filterModelRows(rows, 'all', ' QWE ').map((r) => r.model.id)).toEqual([
      'qwen',
    ])
    expect(filterModelRows(rows, 'all', 'nomatch')).toEqual([])
  })
})
