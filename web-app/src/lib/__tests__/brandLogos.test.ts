import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { modelLogo, providerLogo } from '../brandLogos'

const PUBLIC = resolve(__dirname, '../../../public')

describe('brand logos', () => {
  it('maps providers to the bundled LobeHub marks', () => {
    expect(providerLogo('anthropic')).toEqual({
      src: '/images/logos/anthropic.svg',
      mono: true,
    })
    expect(providerLogo('gemini')?.src).toBe('/images/logos/gemini-color.svg')
    expect(providerLogo('xai')?.src).toBe('/images/logos/grok.svg')
  })

  it('falls back to the older provider images, then to nothing', () => {
    expect(providerLogo('llamacpp')?.src).toBe(
      '/images/model-provider/llamacpp.svg'
    )
    expect(providerLogo('my-gateway')).toBeUndefined()
  })

  it('recognises model families by id, whoever serves them', () => {
    expect(modelLogo('Qwen3-14B-Q4_K_M')?.src).toContain('qwen')
    expect(modelLogo('unsloth/gemma-3-12b-it')?.src).toContain('gemma')
    expect(modelLogo('claude-opus-5-5')?.src).toContain('claude')
    expect(modelLogo('Llama-4-Scout-17B')?.src).toContain('meta')
    expect(modelLogo('gpt-5', 'openrouter')?.src).toContain('openai')
    // Unknown family on a remote provider: the provider's mark.
    expect(modelLogo('some-model', 'anthropic')?.src).toContain('anthropic')
    // Unknown family on the local engine: no mark, the tile shows a letter.
    expect(modelLogo('my-finetune', 'llamacpp')).toBeUndefined()
  })

  it('only points at files that are shipped, with their licence', () => {
    const ids = ['anthropic', 'openai', 'gemini', 'mistral', 'xai', 'huggingface', 'openrouter']
    for (const id of ids) {
      const logo = providerLogo(id)!
      expect(existsSync(resolve(PUBLIC, `.${logo.src}`)), logo.src).toBe(true)
    }
    for (const model of ['qwen3', 'gemma-3', 'claude', 'llama-3', 'deepseek-r1', 'mistral-small', 'grok-4']) {
      const logo = modelLogo(model)!
      expect(existsSync(resolve(PUBLIC, `.${logo.src}`)), logo.src).toBe(true)
    }
    expect(existsSync(resolve(PUBLIC, 'images/logos/LICENSE-lobehub.txt'))).toBe(true)
  })
})
