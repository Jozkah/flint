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

  it('keeps a paragraph that comes back after something else', () => {
    expect(cleanReply('A\n\nB\n\nA')).toBe('A\n\nB\n\nA')
  })
})
