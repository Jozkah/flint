import { describe, it, expect } from 'vitest'
import {
  disambiguateModels,
  type DisambiguationInput,
} from '../modelDisplayName'

const m = (
  key: string,
  extra: Partial<DisambiguationInput> = {}
): DisambiguationInput => ({ key, name: key, fileName: `${key}.gguf`, ...extra })

const labels = (list: DisambiguationInput[]) =>
  Object.fromEntries(
    [...disambiguateModels(list)].map(([k, v]) => [k, v.label])
  )

describe('disambiguateModels', () => {
  it('gives unique names nothing', () => {
    expect(
      disambiguateModels([m('Qwen3-8B-Q4_K_M'), m('Llama-3.1-8B-Q4_K_M')]).size
    ).toBe(0)
  })

  it('uses the quant when only the quant differs', () => {
    const a = 'Qwen3.6-27B-Fable-Fus-711-UnHeretic-IQ4_XS'
    const b = 'Qwen3.6-27B-Fable-Fus-711-UnHeretic-Q4_K_M'
    const r = disambiguateModels([m(a), m(b)])
    expect(r.get(a)).toEqual({ label: 'IQ4_XS', kind: 'quant' })
    expect(r.get(b)).toEqual({ label: 'Q4_K_M', kind: 'quant' })
  })

  it('handles the Cydonia pair of quants', () => {
    const l = labels([
      m('Cydonia-24B-v4.3-absolute-heresy-Q5_K_M'),
      m('Cydonia-24B-v4.3-absolute-heresy-Q8_0'),
    ])
    expect(Object.values(l).sort()).toEqual(['Q5_K_M', 'Q8_0'])
  })

  it('reads the differing segments for the LFM pair', () => {
    const a = 'LFM2.5-2.6B-Q3.8-TBrilliance-BF16'
    const b = 'LFM2.5-2.6B-Q3.8-NEO-MAX-Q3_K_M'
    const l = labels([m(a), m(b)])
    expect(l[a]).toBe('TBrilliance-BF16')
    expect(l[b]).toBe('NEO-MAX-Q3_K_M')
    for (const v of Object.values(l)) expect(v.length).toBeLessThanOrEqual(18)
  })

  it('reads file segments when the shown names are identical', () => {
    const l = labels([
      m('a', {
        name: 'LFM2.5-2.6B',
        fileName: 'LFM2.5-2.6B-Q3.8-TBrilliance-BF16.gguf',
      }),
      m('b', {
        name: 'LFM2.5-2.6B',
        fileName: 'LFM2.5-2.6B-Q3.8-NEO-MAX-Q3_K_M.gguf',
      }),
    ])
    expect(l).toEqual({ a: 'TBrilliance-BF16', b: 'NEO-MAX-Q3_K_M' })
  })

  it('does not touch a differently named long model', () => {
    const r = disambiguateModels([
      m('Qwen3.8-27B-TTURBO-Fable-C-Fusion-709'),
      m('Qwen3.6-27B-Fable-Fus-711-UnHeretic-Q4_K_M'),
      m('Qwen3.6-27B-Fable-Fus-711-UnHeretic-IQ4_XS'),
    ])
    expect(r.has('Qwen3.8-27B-TTURBO-Fable-C-Fusion-709')).toBe(false)
    expect(r.size).toBe(2)
  })

  it('falls back to size when names and quants are identical', () => {
    const l = labels([
      m('one', {
        name: 'same-model',
        fileName: 'same-model.gguf',
        sizeBytes: 5.0 * 1024 ** 3,
      }),
      m('two', {
        name: 'same-model',
        fileName: 'same-model.gguf',
        sizeBytes: 2.9 * 1024 ** 3,
      }),
    ])
    expect(l).toEqual({ one: '5.0 GB', two: '2.9 GB' })
  })

  it('numbers identical models in key order', () => {
    const l = labels([
      m('b', { name: 'same', fileName: 'same.gguf' }),
      m('a', { name: 'same', fileName: 'same.gguf' }),
    ])
    expect(l).toEqual({ a: '#1', b: '#2' })
  })

  it('is stable across list order', () => {
    const list = [
      m('LFM2.5-2.6B-Q3.8-TBrilliance-BF16'),
      m('LFM2.5-2.6B-Q3.8-NEO-MAX-Q3_K_M'),
      m('Other-1B-Q4_K_M'),
    ]
    expect(labels(list)).toEqual(labels([...list].reverse()))
  })

  it('cuts a long label in the middle to 18 characters', () => {
    const l = labels([
      m('Shared-Prefix-Name-That-Is-Long-AlphaVeryLongDifferingSegmentName'),
      m('Shared-Prefix-Name-That-Is-Long-BetaVeryLongDifferingSegmentName'),
    ])
    for (const v of Object.values(l)) {
      expect(v.length).toBeLessThanOrEqual(18)
      expect(v).toContain('…')
    }
  })
})
