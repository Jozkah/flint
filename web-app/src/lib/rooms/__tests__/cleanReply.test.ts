import { describe, expect, it } from 'vitest'
import { cleanReply } from '../cleanReply'

describe('cleanReply', () => {
  it('drops a copied header so the @address that follows leads the reply', () => {
    expect(cleanReply('[Mara (Plan) to room]:\n\n@Nina run the tests')).toBe('@Nina run the tests')
    expect(cleanReply('[Mara (Plan) to room]: @Nina run it')).toBe('@Nina run it')
  })

  it('collapses the same paragraph repeated back to back', () => {
    const p = 'The fix is already in cli.py.'
    expect(cleanReply(`[Mara to room]:\n\n${p}\n\n[Mara to room]:\n\n${p}\n\n${p}`)).toBe(p)
  })

  it('keeps ordinary text, brackets and repeated words elsewhere', () => {
    const t = 'See [1] and [the docs] for details.\n\nRun it. Run it again.'
    expect(cleanReply(t)).toBe(t)
  })

  it('keeps one copy of a whole reply written twice with no break between (R-018)', () => {
    const p = 'Once upon a time a lighthouse keeper found a bottle. Inside was a map of the stars.'
    expect(cleanReply(`${p}${p}`)).toBe(p)
    expect(cleanReply(`${p} ${p}`)).toBe(p)
    expect(cleanReply(`${p}\n${p}`)).toBe(p)
    // A short echo ("Yes. Yes.") is left alone.
    expect(cleanReply('Yes.Yes.')).toBe('Yes.Yes.')
  })

  it('keeps a paragraph that comes back after something else', () => {
    expect(cleanReply('A\n\nB\n\nA')).toBe('A\n\nB\n\nA')
  })
})

describe('cleanReply: echoed room scaffold', () => {
  it('drops a "[Room to X]:" header even behind a stray table pipe or quote mark', () => {
    expect(cleanReply('| [Room to Tiny]: 42')).toBe('42')
    expect(cleanReply('> [Room to Tiny]: hello')).toBe('hello')
    expect(cleanReply('[Room to Tiny]:\nThe answer is 42.')).toBe('The answer is 42.')
    // A real table row is left alone.
    expect(cleanReply('| a | b |\n|---|---|')).toBe('| a | b |\n|---|---|')
  })
})
