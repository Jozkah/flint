import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { buildContextBreakdown, reconcileBreakdown } from '../contextBreakdown'

const user = (text: string) =>
  ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const byId = (b: ReturnType<typeof buildContextBreakdown>, id: string) =>
  b.segments.find((s) => s.id === id)

describe('buildContextBreakdown', () => {
  it('splits the request into messages, tools, skills, memory and the rest of the prompt', () => {
    const skills = '# Skills\n' + 'x'.repeat(400)
    const memory = '# Memory\n' + 'm'.repeat(200)
    const b = buildContextBreakdown({
      systemPrompt: `You are Flint.\n\n${skills}\n\n${memory}`,
      skillTexts: [skills],
      memoryTexts: [memory],
      tools: [
        { name: 'read', schema: { d: 'r'.repeat(80) } },
        { name: 'notion_search', schema: { d: 's'.repeat(400) }, server: 'notion' },
        { name: 'notion_fetch', schema: { d: 'f'.repeat(400) }, server: 'notion' },
        { name: 'ida_decompile', schema: { d: 'd'.repeat(300) }, server: 'ida' },
      ],
      messages: [user('hello '.repeat(50))],
    })
    expect(byId(b, 'skills')?.tokens).toBeGreaterThan(90)
    expect(byId(b, 'memory')?.tokens).toBeGreaterThan(40)
    // Only what is left of the prompt is "System prompt".
    expect(byId(b, 'systemPrompt')?.tokens).toBeLessThan(10)
    expect(byId(b, 'systemTools')?.children?.map((c) => c.label)).toEqual(['read'])
    const mcp = byId(b, 'mcpTools')
    expect(mcp?.children?.map((c) => c.label)).toEqual(['notion', 'ida'])
    expect(mcp!.tokens).toBeGreaterThan(byId(b, 'systemTools')!.tokens)
    expect(byId(b, 'messages')?.tokens).toBeGreaterThan(50)
  })

  it('ignores a block that is not actually in the prompt', () => {
    const b = buildContextBreakdown({
      systemPrompt: 'Just this.',
      skillTexts: ['# Skills that were never sent'],
      tools: [],
      messages: [],
    })
    expect(byId(b, 'skills')).toBeUndefined()
  })

  it('leaves out kinds that are empty', () => {
    const b = buildContextBreakdown({ systemPrompt: 'hi there', tools: [], messages: [] })
    expect(b.segments.map((s) => s.id)).toEqual(['systemPrompt'])
  })

  it('folds a long list of tools into "N more"', () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, schema: { i } }))
    const b = buildContextBreakdown({ systemPrompt: '', tools, messages: [] })
    const kids = byId(b, 'systemTools')!.children!
    expect(kids).toHaveLength(13)
    expect(kids[12].label).toBe('8 more')
  })
})

describe('reconcileBreakdown', () => {
  const base = buildContextBreakdown({
    systemPrompt: 'p'.repeat(400),
    tools: [{ name: 'read', schema: { d: 'r'.repeat(400) } }],
    messages: [user('a'.repeat(400))],
  })
  const sum = (segs: { tokens: number }[]) => segs.reduce((n, s) => n + s.tokens, 0)

  it('keeps the measurement when the total is not larger', () => {
    const r = reconcileBreakdown(base, 1)
    expect(r.segments).toBe(base.segments)
    expect(r.usedTokens).toBe(sum(base.segments))
  })

  it('gives the growth since the request to the messages, so the parts add up to the total', () => {
    const total = sum(base.segments) + 5000
    const r = reconcileBreakdown(base, total)
    expect(r.usedTokens).toBe(total)
    expect(sum(r.segments)).toBe(total)
    expect(r.segments.find((s) => s.id === 'messages')!.tokens).toBe(
      base.segments.find((s) => s.id === 'messages')!.tokens + 5000
    )
  })

  it('says "Unmeasured" when there was no conversation to grow', () => {
    const noMessages = buildContextBreakdown({
      systemPrompt: 'p'.repeat(400),
      tools: [],
      messages: [],
    })
    const r = reconcileBreakdown(noMessages, sum(noMessages.segments) + 300)
    expect(r.segments.at(-1)).toMatchObject({ id: 'unmeasured', tokens: 300 })
  })
})
