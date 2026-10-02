import { describe, expect, it } from 'vitest'
import { pickLicense, weightsFiles } from '../discover'

describe('weightsFiles', () => {
  it('keeps the model weights, smallest first, and drops encoders, VAEs and projectors', () => {
    const files = [
      { name: 'Qwen_Image-Q8_0.gguf', size: 21 },
      { name: 'Qwen_Image-Q4_K_M.gguf', size: 13 },
      { name: 'qwen_image_vae.safetensors', size: 1 },
      { name: 'Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf', size: 1 },
      { name: 'clip_l.gguf', size: 1 },
      { name: 'text_encoders/t5xxl-Q4.gguf', size: 3 },
      { name: 'README.md', size: 1 },
    ]
    expect(weightsFiles(files).map((f) => f.name)).toEqual([
      'Qwen_Image-Q4_K_M.gguf',
      'Qwen_Image-Q8_0.gguf',
    ])
  })

  it('does not drop a model whose name merely contains one of those letters', () => {
    expect(
      weightsFiles([{ name: 'flux1-schnell-q4_k.gguf', size: 7 }]).length
    ).toBe(1)
    expect(weightsFiles([{ name: 'svd-q8.gguf', size: 7 }]).length).toBe(1)
  })
})

describe('pickLicense', () => {
  it('reads the card, then the tags, then says it is unknown', () => {
    expect(pickLicense({ cardData: { license: 'apache-2.0' }, tags: [] })).toBe(
      'apache-2.0'
    )
    expect(pickLicense({ cardData: { license: ['mit'] }, tags: [] })).toBe(
      'mit'
    )
    expect(
      pickLicense({ cardData: null, tags: ['gguf', 'license:other'] })
    ).toBe('other')
    expect(pickLicense({ cardData: null, tags: [] })).toBe('unknown licence')
  })
})
