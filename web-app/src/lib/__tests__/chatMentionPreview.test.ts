import { describe, expect, it } from 'vitest'
import { previewMentions } from '@/lib/chatMentionPreview'

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
