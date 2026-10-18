import { describe, expect, it } from 'vitest'
import { estimateUnmeasuredTokens } from '../useTokensCount'
import type { ThreadMessage } from '@janhq/core'
import { estimateTokens } from '@/lib/context-manager'

const msg = (role: string, text: string, usage?: unknown, extra: Record<string, unknown> = {}) =>
  ({
    id: `${role}-${text.length}`,
    role,
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
    metadata: { ...(usage ? { usage } : {}), ...extra },
  }) as unknown as ThreadMessage

describe('estimateUnmeasuredTokens', () => {
  it('counts only what came after the last measured message', () => {
    const messages = [
      msg('user', 'a'.repeat(400)),
      msg('assistant', 'b'.repeat(400), { totalTokens: 250 }),
      msg('user', 'c'.repeat(80)),
    ]
    expect(estimateUnmeasuredTokens(messages)).toBe(estimateTokens('c'.repeat(80)))
  })

  it('is zero when the last message was measured', () => {
    const messages = [
      msg('user', 'a'.repeat(400)),
      msg('assistant', 'b'.repeat(400), { totalTokens: 250 }),
    ]
    expect(estimateUnmeasuredTokens(messages)).toBe(0)
  })

  it('counts a pasted inline attachment, not only the typed text', () => {
    // The user's case: the ring read 1.7K while the request carried a 20K paste.
    const messages = [
      msg('user', 'summarize this', undefined, {
        inline_file_contents: [{ name: 'pasted-text-1.txt', content: 'x'.repeat(70_000) }],
      }),
    ]
    expect(estimateUnmeasuredTokens(messages)).toBeGreaterThanOrEqual(20_000)
  })

  it('adds the fixed prompt (system + tool schemas) when nothing was measured yet', () => {
    const messages = [msg('user', 'hi')]
    expect(estimateUnmeasuredTokens(messages, 1800)).toBe(estimateUnmeasuredTokens(messages) + 1800)
    const measured = [msg('user', 'hi'), msg('assistant', 'yo', { totalTokens: 2000 }), msg('user', 'again')]
    // A measured request already counted it.
    expect(estimateUnmeasuredTokens(measured, 1800)).toBe(estimateUnmeasuredTokens(measured))
  })
})
