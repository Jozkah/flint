import { describe, it, expect, vi } from 'vitest'
import type { CodeHighlighterPlugin } from 'streamdown'
import { guardCodePlugin } from '../guardedCodePlugin'

function fakePlugin() {
  const highlight = vi.fn(() => ({ tokens: [], bg: '', fg: '' }) as never)
  return {
    plugin: { highlight, name: 'shiki' } as unknown as CodeHighlighterPlugin,
    highlight,
  }
}

describe('guardCodePlugin', () => {
  it('delegates ordinary code to Shiki', () => {
    const { plugin, highlight } = fakePlugin()
    const res = guardCodePlugin(plugin).highlight({
      code: 'const a = 1',
      language: 'ts',
      themes: ['a', 'b'],
    })
    expect(highlight).toHaveBeenCalledTimes(1)
    expect(res).not.toBeNull()
  })

  it('skips highlighting a 20k-char minified line and stays fast', () => {
    const { plugin, highlight } = fakePlugin()
    const code = 'var a=1;'.repeat(2500)
    const start = performance.now()
    const res = guardCodePlugin(plugin).highlight({
      code,
      language: 'js',
      themes: ['a', 'b'],
    })
    expect(performance.now() - start).toBeLessThan(50)
    expect(res).toBeNull()
    expect(highlight).not.toHaveBeenCalled()
  })
})
