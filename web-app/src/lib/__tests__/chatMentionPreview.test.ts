import { describe, expect, it } from 'vitest'
import { previewMentions, toggleSummary } from '@/lib/chatMentionPreview'

describe('previewMentions', () => {
  it('shows an unmatched token typed twice once', async () => {
    const out = await previewMentions(
      'compare @chat:nothing-here and again @chat:nothing-here',
      [],
      async () => null
    )
    expect(out.map((p) => p.status)).toEqual(['missing'])
  })

  it('still shows two different unmatched tokens', async () => {
    const out = await previewMentions('@chat:aaa @chat:bbb', [], async () => null)
    expect(out).toHaveLength(2)
  })
})

describe('toggleSummary', () => {
  it('leaves the #summary form alone when toggling the plain token', () => {
    expect(
      toggleSummary('@chat:foo-1234 and @chat:foo-1234#summary', 'chat:foo-1234')
    ).toBe('@chat:foo-1234#summary and @chat:foo-1234#summary')
  })

  it('turns the #summary form back into the plain token', () => {
    expect(
      toggleSummary('see @chat:foo-1234#summary', 'chat:foo-1234#summary')
    ).toBe('see @chat:foo-1234')
  })
})
