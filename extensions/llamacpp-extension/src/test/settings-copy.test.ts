import { describe, expect, it } from 'vitest'
import settings from '../../settings.json'

type Setting = { key: string; title: string; description: string }
const all = settings as Setting[]
const byKey = (k: string) => all.find((s) => s.key === k)!

describe('llama.cpp settings copy', () => {
  it('names the fit switch Auto-fit, like its related settings', () => {
    expect(byKey('fit').title).toBe('Auto-fit')
    expect(byKey('fit_ctx').title.startsWith('Auto-fit')).toBe(true)
    expect(byKey('fit_target').title).toBe('Auto-fit: memory to keep free')
    expect(byKey('fit').description).toBe(
      'Let Flint decide how many layers run on the GPU and how large the context can be, so the model fits in your memory. Turn it off to set GPU layers and Context Size yourself.'
    )
    // The smallest-context control says it is not the context size, and where that is set.
    expect(byKey('fit_ctx').description).toContain('This is not the context size')
    expect(byKey('fit_ctx').description).toContain('Default context size')
  })

  it('offers a Default context size right above the Auto-fit controls', () => {
    const keys = all.map((s) => s.key)
    expect(keys.indexOf('ctx_size')).toBe(keys.indexOf('fit') - 1)
    expect(byKey('ctx_size').title).toBe('Default context size')
    expect(byKey('ctx_size').description).toContain('Leave on Auto')
  })

  it('never calls the app Jan in user-visible text', () => {
    for (const s of all) {
      expect(`${s.title} ${s.description}`).not.toMatch(/\bJan\b/)
    }
  })
})
