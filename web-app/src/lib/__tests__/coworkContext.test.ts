import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  BUDGET_METHOD,
  ESTIMATE_METHOD,
  conversationText,
  estimateTokens,
  measureContextPack,
  shapingFor,
  shapingNotice,
  shapingWorthReporting,
  unchangedShaping,
  utf8Bytes,
} from '@/lib/coworkContext'
import {
  accountedTotal,
  CONTEXT_CATEGORIES,
  UNKNOWN_SHAPING,
} from '@/lib/coworkReadiness'

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

  it('bills the map to its own category and not to instructions twice', () => {
    // The map is a block *of* the system prompt. Counting the whole prompt as
    // instructions and the map again beside it would make the categories sum
    // past what the run actually sends, which is the one thing this accounting
    // exists to prevent.
    const map = '# Repository map\n\nsrc/'
    const system = `You are Jan.\n\n${map}\n\nBe careful.`
    const accounting = measureContextPack({
      systemPrompt: system,
      toolSchemas: {},
      messages: [],
      repositoryMap: map,
    })
    const bytes = (text: string) => new TextEncoder().encode(text).length
    expect(accounting.categories.repositoryMap).toEqual({
      known: 'estimated',
      tokens: Math.round(bytes(map) / 4),
      method: ESTIMATE_METHOD,
    })
    expect(accounting.categories.instructions).toEqual({
      known: 'estimated',
      tokens: Math.round((bytes(system) - bytes(map)) / 4),
      method: ESTIMATE_METHOD,
    })
    const instructions = accounting.categories.instructions
    const repositoryMap = accounting.categories.repositoryMap
    const sum =
      (instructions.known === false ? 0 : instructions.tokens) +
      (repositoryMap.known === false ? 0 : repositoryMap.tokens)
    // Within rounding of the whole prompt: the two categories partition it.
    expect(Math.abs(sum - bytes(system) / 4)).toBeLessThanOrEqual(1)
  })

  it('never reports a negative instruction budget', () => {
    // A caller passing a block the prompt does not contain is a bug, not a
    // reason to show the user a negative number.
    const accounting = measureContextPack({
      systemPrompt: 'short',
      toolSchemas: {},
      messages: [],
      repositoryMap: 'a much longer block than the prompt itself',
    })
    expect(accounting.categories.instructions).toEqual({
      known: true,
      tokens: 0,
    })
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

describe('what the context manager did on the way out', () => {
  const message = (text: string) =>
    ({ id: 'm', role: 'user', parts: [{ type: 'text', text }] }) as never

  it('reports an untouched payload as sent whole', () => {
    const sent = [message('a'), message('b')]
    expect(shapingFor({ kind: 'unchanged', before: sent, after: sent })).toEqual({
      kind: 'unchanged',
      removed: 0,
      retained: 2,
      removedTokens: { known: true, tokens: 0 },
      reason: null,
    })
  })

  it('measures what was removed as the difference between the payloads', () => {
    // Not "the first N messages": compaction rewrites as well as drops, so the
    // messages that are gone are not the same set as the messages that were
    // first.
    const before = [message('x'.repeat(400)), message('keep')]
    const after = [message('summary')]
    const shaping = shapingFor({ kind: 'compacted', before, after })

    expect(shaping.kind).toBe('compacted')
    expect(shaping.removed).toBe(1)
    expect(shaping.retained).toBe(1)
    expect(shaping.removedTokens).toEqual({
      known: 'estimated',
      tokens: Math.round((400 + 1 + 4 - 7) / 4),
      method: ESTIMATE_METHOD,
    })
  })

  it('reports a failed compaction even when the fallback removed nothing', () => {
    // The window in force is not the one that was configured. That is worth
    // saying whether or not the trim then had to cut anything.
    const sent = [message('a')]
    const shaping = shapingFor({
      kind: 'failed',
      before: sent,
      after: sent,
      reason: 'model unavailable',
    })
    expect(shaping.kind).toBe('failed')
    expect(shaping.reason).toBe('model unavailable')
    expect(shapingWorthReporting(shaping)).toBe(true)
  })

  it('does not put an unchanged or un-dispatched payload in the summary', () => {
    expect(shapingWorthReporting(unchangedShaping(3))).toBe(false)
    expect(shapingWorthReporting(UNKNOWN_SHAPING)).toBe(false)
  })

  it('never carries message text into the record', () => {
    const secret = 'sk-not-a-real-key-0123456789'
    const shaping = shapingFor({
      kind: 'trimmed',
      before: [message(secret), message('keep')],
      after: [message('keep')],
    })
    expect(JSON.stringify(shaping)).not.toContain(secret)
  })

  it('hands one wording, with its counts, to every surface that reports it', () => {
    // The breakdown and the completion summary read from here rather than each
    // phrasing it, because two surfaces describing the same run in their own
    // words is how they end up disagreeing about whether anything was dropped.
    const notice = shapingNotice(
      shapingFor({
        kind: 'trimmed',
        before: [message('x'.repeat(4000)), message('keep')],
        after: [message('keep')],
      })
    )
    expect(notice.key).toBe('common:readiness.shaping.trimmed')
    expect(notice.params.removed).toBe(1)
    expect(notice.params.retained).toBe(1)
    expect(notice.params.tokens).toBeGreaterThan(900)
    expect(notice.params.reason).toBe('')
  })

  it('reports the un-dispatched state as its own thing, not as clean', () => {
    expect(shapingNotice(UNKNOWN_SHAPING).key).toBe(
      'common:readiness.shaping.unknown'
    )
    expect(UNKNOWN_SHAPING.removedTokens).toEqual({ known: false })
  })

  it('defaults the accounting to unknown rather than to unchanged', () => {
    // A pack measured without a shaping record has not established that
    // nothing was removed; it has established nothing.
    const accounting = measureContextPack({
      systemPrompt: 'x',
      toolSchemas: {},
      messages: [],
    })
    expect(accounting.shaping).toEqual(UNKNOWN_SHAPING)
  })
})
