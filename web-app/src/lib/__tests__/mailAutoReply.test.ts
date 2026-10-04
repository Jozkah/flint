import { describe, expect, it, vi } from 'vitest'
import { answerMail, createMailLedger, finalAnswerText } from '../mailAutoReply'

const sender = (messageId: string, depth = 0) => ({
  sessionId: 'a',
  displayName: 'Weather API',
  messageId,
  depth,
})

describe('mail ledger', () => {
  it('keeps each message once and only the requests, not the replies', () => {
    const ledger = createMailLedger()
    ledger.note(sender('m1'))
    ledger.note(sender('m1'))
    ledger.note(sender('m2', 1))
    ledger.note(undefined)
    expect(ledger.unanswered().map((m) => m.messageId)).toEqual(['m1'])
  })
})

describe('finalAnswerText', () => {
  it('is the last assistant message with words in it', () => {
    expect(
      finalAnswerText([
        { role: 'user', parts: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', parts: [{ type: 'text', text: ' recharts ' }] },
        { role: 'assistant', parts: [{ type: 'tool-bash' }] },
      ])
    ).toBe('recharts')
    expect(finalAnswerText([])).toBe('')
  })
})

describe('answerMail', () => {
  it('replies to each request with the final answer', async () => {
    const autoReply = vi.fn(async () => ({ messageId: 'x', deliveredToStatus: 'running' as const }))
    const sent = await answerMail('b', [sender('m1'), sender('m2')], 'recharts', { autoReply })
    expect(sent).toBe(2)
    expect(autoReply).toHaveBeenCalledWith({ fromSessionId: 'b', replyTo: 'm1', text: 'recharts' })
    expect(autoReply).toHaveBeenCalledWith({ fromSessionId: 'b', replyTo: 'm2', text: 'recharts' })
  })

  it('sends nothing for an empty answer and counts only what the backend sent', async () => {
    const autoReply = vi.fn(async () => null)
    expect(await answerMail('b', [sender('m1')], '   ', { autoReply })).toBe(0)
    expect(autoReply).not.toHaveBeenCalled()
    expect(await answerMail('b', [sender('m1')], 'answer', { autoReply })).toBe(0)
  })

  it('survives a refusal and still tries the next message', async () => {
    const autoReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('session_deleted'))
      .mockResolvedValueOnce({ messageId: 'x', deliveredToStatus: 'idle' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await answerMail('b', [sender('m1'), sender('m2')], 'answer', { autoReply })).toBe(1)
    warn.mockRestore()
  })
})
