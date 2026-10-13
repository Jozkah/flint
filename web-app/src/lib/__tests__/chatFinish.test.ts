import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { isEmptyReply } from '../chatFinish'
import { isContextOverflowMessage, isLocalContextOverflowMessage } from '@/utils/error'

const assistant = (parts: UIMessage['parts']): UIMessage => ({
  id: 'a1',
  role: 'assistant',
  parts,
})

const base = { isAbort: false, isError: false, finishReason: 'stop' }

describe('isEmptyReply', () => {
  it('flags a finished assistant turn with no parts', () => {
    expect(isEmptyReply({ message: assistant([]), ...base })).toBe(true)
  })

  it('does not flag a reply with text', () => {
    expect(
      isEmptyReply({
        message: assistant([{ type: 'text', text: 'hello' }]),
        ...base,
      })
    ).toBe(false)
  })

  it('skips aborted, errored and tool-call turns', () => {
    const message = assistant([])
    expect(isEmptyReply({ message, ...base, isAbort: true })).toBe(false)
    expect(isEmptyReply({ message, ...base, isError: true })).toBe(false)
    expect(isEmptyReply({ message, ...base, finishReason: 'tool-calls' })).toBe(
      false
    )
  })

  it('skips non-assistant messages', () => {
    expect(
      isEmptyReply({ message: { ...assistant([]), role: 'user' }, ...base })
    ).toBe(false)
  })
})

describe('cloud context overflow wording', () => {
  it('recognises provider overflows but only localizes llama-server ones', () => {
    const anthropic = 'prompt is too long: 250000 tokens > 200000 maximum'
    const openai = "This model's maximum context length is 128000 tokens"
    const llama = 'request (900 tokens) exceeds the available context size (512 tokens)'
    for (const m of [anthropic, openai, llama]) {
      expect(isContextOverflowMessage(m)).toBe(true)
    }
    expect(isLocalContextOverflowMessage(llama)).toBe(true)
    expect(isLocalContextOverflowMessage(anthropic)).toBe(false)
    expect(isLocalContextOverflowMessage(openai)).toBe(false)
  })
})
