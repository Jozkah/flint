import { describe, it, expect } from 'vitest'
import { MAX_DEEP_LINK_PROMPT, promptFromDeepLink } from '../deepLinkPrompt'

describe('promptFromDeepLink', () => {
  it('reads the prompt of a flint chat link', () => {
    expect(promptFromDeepLink('flint://chat?prompt=Explain%20GGUF%20quants')).toBe(
      'Explain GGUF quants'
    )
    expect(promptFromDeepLink('jan://prompt?prompt=hello+there')).toBe('hello there')
  })

  it('keeps line breaks, drops control characters and trims', () => {
    expect(
      promptFromDeepLink('flint://chat?prompt=%20a%0D%0Ab%00c%07%20')
    ).toBe('a\nbc')
  })

  it('caps the length', () => {
    const long = 'x'.repeat(MAX_DEEP_LINK_PROMPT + 50)
    expect(promptFromDeepLink(`flint://chat?prompt=${long}`)).toHaveLength(
      MAX_DEEP_LINK_PROMPT
    )
  })

  it('ignores links without a usable prompt or from another place', () => {
    expect(promptFromDeepLink('flint://chat')).toBeNull()
    expect(promptFromDeepLink('flint://chat?prompt=%20%20')).toBeNull()
    expect(promptFromDeepLink('flint://models/a/b?prompt=hi')).toBeNull()
    expect(promptFromDeepLink('https://chat/?prompt=hi')).toBeNull()
    expect(promptFromDeepLink('not a url')).toBeNull()
  })
})
