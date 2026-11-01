import { describe, it, expect } from 'vitest'
import { applySafeEmojiMode, SAFE_EMOJI_CLASS, SAFE_EMOJI_KEY } from '../safeEmoji'

const root = () => {
  const s = new Set<string>()
  return { classList: { add: (c: string) => s.add(c), has: (c: string) => s.has(c) } }
}

describe('applySafeEmojiMode', () => {
  it('adds the class when the flag is set', () => {
    const r = root()
    expect(applySafeEmojiMode({ getItem: (k) => (k === SAFE_EMOJI_KEY ? '1' : null) }, r as never)).toBe(true)
    expect(r.classList.has(SAFE_EMOJI_CLASS)).toBe(true)
  })
  it('does nothing without the flag or when storage throws', () => {
    const r = root()
    expect(applySafeEmojiMode({ getItem: () => null }, r as never)).toBe(false)
    expect(applySafeEmojiMode({ getItem: () => { throw new Error('x') } }, r as never)).toBe(false)
    expect(applySafeEmojiMode(undefined, r as never)).toBe(false)
    expect(r.classList.has(SAFE_EMOJI_CLASS)).toBe(false)
  })
})
