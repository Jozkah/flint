import { describe, it, expect } from 'vitest'
import { modelsNeedingVisionProbe } from '../visionProbe'

describe('modelsNeedingVisionProbe', () => {
  const models = [
    { id: 'a', capabilities: [] },
    { id: 'b', capabilities: ['vision'] },
    { id: 'c' },
  ]

  it('probes models without vision that were not probed yet', () => {
    expect(modelsNeedingVisionProbe(models, new Set())).toEqual(['a', 'c'])
  })

  // Regression for #83: a providers-store update while the dropdown is open
  // must not re-probe models that were already probed.
  it('skips models already probed in this session', () => {
    const probed = new Set(modelsNeedingVisionProbe(models, new Set()))
    expect(modelsNeedingVisionProbe(models, probed)).toEqual([])
  })

  it('probes a model added after the first pass', () => {
    const probed = new Set(['a', 'c'])
    expect(
      modelsNeedingVisionProbe([...models, { id: 'd', capabilities: [] }], probed)
    ).toEqual(['d'])
  })
})
