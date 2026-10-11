import { describe, expect, it } from 'vitest'
import type { HuggingFaceFileGroup } from '@/lib/huggingface'
import {
  groupVariants,
  quantFamily,
  selectShortList,
} from '@/lib/hubVariants'

const g = (quant: string, size = 1): HuggingFaceFileGroup => {
  const file = { name: `m-${quant}.gguf`, size }
  return {
    id: quant,
    files: [file],
    primary: file,
    quantization: quant,
    totalSize: size,
    multipart: false,
    kind: 'model',
  }
}

describe('selectShortList', () => {
  const all = ['Q2_K', 'Q3_K_M', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16'].map(
    (q, i) => g(q, i + 1)
  )

  it('puts the recommended first, then common quants', () => {
    const out = selectShortList(all, 'Q6_K')
    expect(out.map((v) => v.id)).toEqual(['Q6_K', 'Q4_K_M', 'Q5_K_M', 'Q8_0'])
  })

  it('has no duplicates and respects the limit', () => {
    expect(selectShortList(all, 'Q4_K_M', 2)).toHaveLength(2)
    expect(selectShortList([g('Q4_K_M')], 'Q4_K_M')).toHaveLength(1)
  })

  it('fills with the smallest when common quants are missing', () => {
    const out = selectShortList([g('IQ2_XS', 5), g('IQ1_S', 1)], null, 1)
    expect(out[0].id).toBe('IQ1_S')
  })
})

describe('groupVariants', () => {
  it('stays flat at or under 12', () => {
    const out = groupVariants(Array.from({ length: 12 }, () => g('Q4_K_M')))
    expect(out).toEqual([{ title: null, items: expect.any(Array) }])
  })

  it('groups by family above 12', () => {
    const list = [
      ...Array.from({ length: 10 }, () => g('Q4_K_M')),
      g('Q8_0'),
      g('IQ3_XS'),
      g('F16'),
    ]
    const titles = groupVariants(list).map((s) => s.title)
    expect(titles).toEqual(
      expect.arrayContaining(['4-bit', '8-bit', 'Compact (IQ)', 'Full precision'])
    )
  })

  it('names families', () => {
    expect(quantFamily('BF16')).toBe('Full precision')
    expect(quantFamily(null)).toBe('Other')
  })
})
