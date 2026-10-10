import { describe, expect, it } from 'vitest'
import { estimateUnmeasuredTokens } from '../useTokensCount'
import type { ThreadMessage } from '@janhq/core'

const msg = (role: string, text: string, usage?: unknown) =>
  ({
    id: `${role}-${text.length}`,
    role,
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
    metadata: usage ? { usage } : {},
  }) as unknown as ThreadMessage

describe('estimateUnmeasuredTokens', () => {
  it('counts only what came after the last measured message', () => {
    const messages = [
      msg('user', 'a'.repeat(400)),
      msg('assistant', 'b'.repeat(400), { totalTokens: 250 }),
      msg('user', 'c'.repeat(80)),
    ]
    expect(estimateUnmeasuredTokens(messages)).toBe(20)
  })

  it('is zero when the last message was measured', () => {
    const messages = [
      msg('user', 'a'.repeat(400)),
      msg('assistant', 'b'.repeat(400), { totalTokens: 250 }),
    ]
    expect(estimateUnmeasuredTokens(messages)).toBe(0)
  })
})
