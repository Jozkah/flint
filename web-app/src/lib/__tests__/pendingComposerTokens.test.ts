import { describe, expect, it } from 'vitest'
import { estimateTokens, pendingComposerTokens } from '../context-manager'

describe('pendingComposerTokens (K-011)', () => {
  it('counts a staged inline document before send', () => {
    const big = 'x'.repeat(105_000) // ~30K tokens
    const n = pendingComposerTokens('', [
      { type: 'document', name: 'log.txt', injectionMode: 'inline', inlineContent: big },
    ])
    expect(n).toBeGreaterThan(29_000)
    expect(n).toBeGreaterThanOrEqual(estimateTokens(big))
  })

  it('adds the typed text and skips documents that are not inlined', () => {
    expect(pendingComposerTokens('hello world', [])).toBe(estimateTokens('hello world'))
    expect(
      pendingComposerTokens('', [
        { type: 'document', name: 'a.pdf', injectionMode: 'embeddings', inlineContent: 'zzz' },
        { type: 'image', name: 'b.png' },
      ])
    ).toBe(0)
  })
})
