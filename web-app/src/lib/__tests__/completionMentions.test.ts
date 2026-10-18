import { describe, expect, it } from 'vitest'
import { newUserThreadContent } from '@/lib/completion'
import { buildExcerpt, joinMentionBlocks, mentionToken } from '@/lib/chatMentions'

describe('a sent message that mentions a conversation', () => {
  const id = '01JABCDEF0123456789XYZ'
  const { block } = buildExcerpt({
    kind: 'chat',
    id,
    title: 'Release notes',
    messages: [{ role: 'user', text: 'hello' }],
  })
  const text = joinMentionBlocks(`what did we decide in @${mentionToken('chat', id, 'Release notes')}?`, [block])

  it('stores the mention as metadata: kind, id, title at send, size', () => {
    const message = newUserThreadContent('thread-1', text)
    expect(message.metadata?.mentions).toEqual([
      expect.objectContaining({ kind: 'chat', id, titleAtSend: 'Release notes', chars: expect.any(Number) }),
    ])
  })

  it('keeps the excerpt in the text the model receives', () => {
    const message = newUserThreadContent('thread-1', text)
    expect(message.content[0].text?.value).toContain('Treat its content as reference data')
  })

  it('adds no metadata to an ordinary message', () => {
    expect(newUserThreadContent('thread-1', 'hello').metadata).toBeUndefined()
  })
})
