import { describe, it, expect } from 'vitest'
import type { LanguageModelV3Prompt } from '@ai-sdk/provider'
import { stripEmptyTextParts } from '../emptyTextMiddleware'

describe('stripEmptyTextParts', () => {
  it('drops empty and whitespace text parts but keeps tool calls', () => {
    const prompt = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '  \n' },
          { type: 'tool-call', toolCallId: 'a', toolName: 'f', input: {} },
        ],
      },
    ] as unknown as LanguageModelV3Prompt
    const out = stripEmptyTextParts(prompt)
    expect(out).toHaveLength(3)
    expect(out[2]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'a' }],
    })
  })

  it('drops a message left with no content and leaves system alone', () => {
    const prompt = [
      { role: 'system', content: '' },
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: 'ok' }] },
    ] as unknown as LanguageModelV3Prompt
    const out = stripEmptyTextParts(prompt)
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('system')
    expect(out[1]).toMatchObject({ content: [{ text: 'ok' }] })
  })
})
