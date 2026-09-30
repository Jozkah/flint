import { describe, expect, it } from 'vitest'
import { syncListedModels } from '../providerModelSync'

const make = (id: string) => ({ id, fresh: true })

describe('syncListedModels', () => {
  it('adds new models and drops the ones the server no longer lists', () => {
    const saved = [{ id: 'a' }, { id: 'b' }]
    const out = syncListedModels(saved, ['b', 'c'], make)
    expect(out.models.map((m) => m.id)).toEqual(['b', 'c'])
    expect(out.added.map((m) => m.id)).toEqual(['c'])
    expect(out.removed.map((m) => m.id)).toEqual(['a'])
  })

  it('keeps what a saved model carries when the server still lists it', () => {
    const saved = [{ id: 'a', note: 'mine' }]
    expect(syncListedModels(saved, ['a'], make).models[0]).toBe(saved[0])
  })

  it('never reads an empty listing as "remove everything"', () => {
    const saved = [{ id: 'a' }]
    const out = syncListedModels(saved, [], make)
    expect(out.models).toEqual(saved)
    expect(out.removed).toEqual([])
  })

  it('adds each new id once', () => {
    expect(syncListedModels([], ['x', 'x'], make).added).toHaveLength(1)
  })
})
