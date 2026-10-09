import { describe, it, expect } from 'vitest'
import {
  EMPTY_REPLY_FALLBACK,
  THINKING_ONLY_FALLBACK,
  emptyRunFallback,
  toolPartError,
} from '@/lib/emptyRunFallback'
import type { MessagePartLike } from '@/containers/message/types'

const tool = (extra: Partial<MessagePartLike>): MessagePartLike => ({
  type: 'tool-bash',
  toolCallId: 'c1',
  ...extra,
})

describe('emptyRunFallback', () => {
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
    expect(EMPTY_REPLY_FALLBACK).toBe(
      'The model returned an empty reply. Try again or switch model.'
    )
  })
})

describe('toolPartError', () => {
  it('ignores successful tools', () => {
    expect(toolPartError(tool({ state: 'output-available', output: 'fine' }))).toBeUndefined()
  })
})
