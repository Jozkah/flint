import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  BUDGET_METHOD,
  ESTIMATE_METHOD,
  conversationText,
  estimateTokens,
  measureContextPack,
  utf8Bytes,
} from '@/lib/coworkContext'
import { accountedTotal, CONTEXT_CATEGORIES } from '@/lib/coworkReadiness'

const text = (value: string): UIMessage =>
  ({ id: 'm', role: 'user', parts: [{ type: 'text', text: value }] }) as UIMessage

describe('measuring text', () => {
  it('counts encoded bytes, not UTF-16 units', () => {
    // The whole reason this is not String.length: a tokenizer sees the encoded
    // form, so a prompt of CJK or emoji must not be reported at a third of its
    // size.
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('日本語')).toBe(9)
    expect('日本語'.length).toBe(3)
    expect(utf8Bytes('🙂')).toBe(4)
  })

  it('labels every derived number with the method that produced it', () => {
    const value = estimateTokens('x'.repeat(400))
    expect(value).toEqual({
      known: 'estimated',
      tokens: 100,
      method: ESTIMATE_METHOD,
    })
  })

  it('distinguishes "nothing was sent" from "nobody knows"', () => {
    // The distinction the card exists to preserve. A zero is an answer.
    expect(estimateTokens('')).toEqual({ known: true, tokens: 0 })
    expect(estimateTokens(null)).toEqual({ known: false })
    expect(estimateTokens(undefined)).toEqual({ known: false })
  })
})

describe('what the conversation costs', () => {
  it('counts tool inputs and results, not just assistant prose', () => {
    // A dozen steps in, a run is mostly tool results. Counting only text would
    // report a large context as a small one.
    const messages = [
      text('hello'),
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'reading' },
          { type: 'tool-read', input: { path: '/a' }, output: 'FILE BODY' },
        ],
      } as unknown as UIMessage,
    ]
    const joined = conversationText(messages)
    expect(joined).toContain('hello')
    expect(joined).toContain('/a')
    expect(joined).toContain('FILE BODY')
  })

  it('survives a tool result that cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const messages = [
      {
        id: 'a',
        role: 'assistant',
        parts: [{ type: 'tool-x', input: circular, output: 'ok' }],
      } as unknown as UIMessage,
    ]
    // One under-counted part is a better outcome than taking the card down.
    expect(() => conversationText(messages)).not.toThrow()
    expect(conversationText(messages)).toContain('ok')
  })

  it('records an error part, which is context the model received', () => {
    const messages = [
      {
        id: 'a',
        role: 'assistant',
        parts: [{ type: 'tool-x', errorText: 'permission denied' }],
      } as unknown as UIMessage,
    ]
    expect(conversationText(messages)).toContain('permission denied')
  })
})

describe('the context pack', () => {
  it('answers every category, leaving none to a default', () => {
    const accounting = measureContextPack({
      systemPrompt: 'a'.repeat(40),
      toolSchemas: { read: { description: 'r' } },
      messages: [text('hi')],
    })
    for (const category of CONTEXT_CATEGORIES) {
      expect(accounting.categories[category]).toBeDefined()
    }
  })

  it('reports the absent repository map as zero, not as unknown', () => {
    // The honest headline. "No map was sent" is the answer to the original
    // complaint; "unknown" would hide it again.
    const accounting = measureContextPack({
      systemPrompt: 'x',
      toolSchemas: {},
      messages: [],
    })
    expect(accounting.categories.repositoryMap).toEqual({
      known: true,
      tokens: 0,
    })
    expect(accounting.categories.skills).toEqual({ known: true, tokens: 0 })
  })

  it('says unknown before a run exists, rather than claiming zero', () => {
    const accounting = measureContextPack({
      systemPrompt: null,
      toolSchemas: null,
      messages: null,
    })
    expect(accounting.categories.instructions).toEqual({ known: false })
    expect(accounting.categories.conversation).toEqual({ known: false })
    expect(accounting.categories.tools).toEqual({ known: false })
    expect(accounting.budget).toEqual({ known: false })
  })

  it('marks a configured window as an estimate, with the reason', () => {
    // llama.cpp's --fit can pick a runtime n_ctx far from the configured size,
    // so the configured number is not the window in force.
    const accounting = measureContextPack({
      systemPrompt: '',
      toolSchemas: {},
      messages: [],
      configuredContextTokens: 8192,
    })
    expect(accounting.budget).toEqual({
      known: 'estimated',
      tokens: 8192,
      method: BUDGET_METHOD,
    })
  })

  it('totals estimates while still declaring them estimates', () => {
    const accounting = measureContextPack({
      systemPrompt: 'a'.repeat(400),
      toolSchemas: null,
      messages: [],
    })
    const total = accountedTotal(accounting)
    expect(total.tokens).toBeGreaterThan(0)
    // Complete is about what is missing; estimated is about how it was got.
    // A reader needs both, and one flag cannot carry them.
    expect(total.complete).toBe(false)
    expect(total.estimated).toBe(true)
  })

  it('does not call a total estimated when every part was counted', () => {
    const accounting = measureContextPack({
      systemPrompt: '',
      toolSchemas: {},
      messages: [],
    })
    const total = accountedTotal(accounting)
    expect(total.complete).toBe(true)
    // `{}` serialises to two characters, so tools is a small estimate; an empty
    // prompt and no map are exact zeros.
    expect(accounting.categories.instructions).toEqual({ known: true, tokens: 0 })
  })
})
