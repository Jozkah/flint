import { describe, it, expect } from 'vitest'
import {
  emptyRunFallback,
  isEmptyReplyBanner,
  toolPartError,
} from '@/lib/emptyRunFallback'
import { i18n } from '@/i18n/react-i18next-compat'
import type { MessagePartLike } from '@/containers/message/types'

const EMPTY_REPLY_FALLBACK =
  'The model returned an empty reply. Try again or switch model.'
const THINKING_ONLY_FALLBACK =
  'The model finished thinking without giving an answer. Continue or regenerate to try again.'

const tool = (extra: Partial<MessagePartLike>): MessagePartLike => ({
  type: 'tool-bash',
  toolCallId: 'c1',
  ...extra,
})

describe('emptyRunFallback', () => {
  it('says nothing about an empty reply when the request failed (401, refused connection)', () => {
    expect(emptyRunFallback([], { failed: true })).toBeNull()
    expect(emptyRunFallback([{ type: 'reasoning', text: 'hmm' }], { failed: true })).toBeNull()
    // The same turn without an error still gets its line.
    expect(emptyRunFallback([])).toBe(EMPTY_REPLY_FALLBACK)
  })

  it('says the model finished thinking when only reasoning came back (#199)', () => {
    expect(
      emptyRunFallback([{ type: 'reasoning', text: 'hmm' }])
    ).toBe(THINKING_ONLY_FALLBACK)
    expect(
      emptyRunFallback([{ type: 'reasoning', text: '  ' }])
    ).toBe(EMPTY_REPLY_FALLBACK)
    expect(
      emptyRunFallback([
        { type: 'reasoning', text: 'hmm' },
        { type: 'text', text: 'answer' },
      ])
    ).toBeNull()
  })

  it('names the last tool error when the run ended with no text', () => {
    const parts = [
      { type: 'text', text: 'Let me check.' },
      tool({ state: 'output-error', errorText: 'sandbox failed to start: os error 203' }),
      { type: 'text', text: '  ' },
    ]
    expect(emptyRunFallback(parts)).toBe(
      'The run ended without a reply. Last tool error (bash): sandbox failed to start: os error 203'
    )
  })

  it('reads an error carried in a tool output', () => {
    const parts = [tool({ state: 'output-available', output: { isError: true, content: [{ type: 'text', text: 'boom' }] } })]
    expect(emptyRunFallback(parts)).toContain('Last tool error (bash): boom')
  })

  it('says only that the run ended when no tool failed', () => {
    expect(emptyRunFallback([tool({ state: 'output-available', output: { ok: 1 } })])).toBe(
      'The run ended without a reply.'
    )
  })

  it('reports how the last step ended when the model answered nothing', () => {
    const parts = [tool({ state: 'output-available', output: { ok: 1 } })]
    expect(
      emptyRunFallback(parts, { stepEnd: { finishReason: 'stop', outputTokens: 0 } })
    ).toBe(
      'The run ended without a reply. The model\'s last step ended with "stop" after 0 output tokens.'
    )
    expect(emptyRunFallback(parts, { stepEnd: { finishReason: 'length' } })).toContain('after ? output tokens')
    expect(emptyRunFallback(parts, { stepEnd: {} })).toBe('The run ended without a reply.')
  })

  it('is null when text follows the tools', () => {
    expect(
      emptyRunFallback([tool({ state: 'output-error', errorText: 'x' }), { type: 'text', text: 'Done.' }])
    ).toBeNull()
  })

  it('is null while a tool is still running or awaiting approval', () => {
    expect(emptyRunFallback([tool({ state: 'input-available' })])).toBeNull()
  })

  it('is null for a message without tools that has text', () => {
    expect(emptyRunFallback([{ type: 'text', text: 'Hello' }])).toBeNull()
  })

  it('says the reply was empty when there is no text and no tool call', () => {
    expect(emptyRunFallback([])).toBe(EMPTY_REPLY_FALLBACK)
    expect(emptyRunFallback([{ type: 'text', text: '  ' }])).toBe(
      EMPTY_REPLY_FALLBACK
    )
    expect(
      emptyRunFallback([{ type: 'reasoning', text: 'thinking' }])
    ).toBe(THINKING_ONLY_FALLBACK)
  })
})

describe('empty reply with no tool calls, step end detail (D13)', () => {
  it('names the finish reason and tokens when the model said how it ended', () => {
    expect(
      emptyRunFallback([], { stepEnd: { finishReason: 'stop', outputTokens: 0 } })
    ).toBe(
      'The model returned an empty reply (finish reason "stop", 0 output tokens). Try again or switch model.'
    )
  })

  it('shows ? for tokens the provider did not report, and the plain line without a reason', () => {
    expect(emptyRunFallback([], { stepEnd: { finishReason: 'stop' } })).toContain('? output tokens')
    expect(emptyRunFallback([], { stepEnd: {} })).toBe(EMPTY_REPLY_FALLBACK)
  })

  it('recognizes its own banner text, plain and detailed, and nothing else', () => {
    expect(isEmptyReplyBanner(i18n.t('model-errors:emptyReply'))).toBe(true)
    expect(
      isEmptyReplyBanner(
        i18n.t('model-errors:emptyReplyDetail', { reason: 'stop', tokens: 0 })
      )
    ).toBe(true)
    expect(isEmptyReplyBanner('401 Unauthorized')).toBe(false)
    expect(isEmptyReplyBanner(undefined)).toBe(false)
  })
})

describe('toolPartError', () => {
  it('ignores successful tools', () => {
    expect(toolPartError(tool({ state: 'output-available', output: 'fine' }))).toBeUndefined()
  })
})
