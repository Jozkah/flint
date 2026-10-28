import { describe, it, expect, beforeEach } from 'vitest'
import {
  activeChatRules,
  buildChatRulesBlock,
  composeSystemMessage,
  estimateTokens,
  CHAT_RULES_TOKEN_BUDGET,
  type ChatRule,
} from '@/lib/chatRules'
import { useChatRules } from '@/hooks/useChatRules'

const rule = (id: string, over: Partial<ChatRule> = {}): ChatRule => ({
  id,
  text: `rule ${id}`,
  enabled: true,
  scope: 'all',
  groupIds: [],
  ...over,
})

describe('activeChatRules', () => {
  it('includes enabled rules in list order', () => {
    const out = activeChatRules([rule('a'), rule('b')], {})
    expect(out.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('excludes disabled and empty rules', () => {
    const out = activeChatRules(
      [rule('a', { enabled: false }), rule('b', { text: '  ' }), rule('c')],
      {}
    )
    expect(out.map((r) => r.id)).toEqual(['c'])
  })

  it('applies group-scoped rules only in their groups', () => {
    const rules = [rule('g', { scope: 'groups', groupIds: ['p1'] })]
    expect(activeChatRules(rules, { groupId: 'p1' })).toHaveLength(1)
    expect(activeChatRules(rules, { groupId: 'p2' })).toHaveLength(0)
    expect(activeChatRules(rules, {})).toHaveLength(0)
  })

  it('drops rules switched off for this chat', () => {
    const out = activeChatRules([rule('a'), rule('b')], { disabledIds: ['a'] })
    expect(out.map((r) => r.id)).toEqual(['b'])
  })
})

describe('buildChatRulesBlock / composeSystemMessage', () => {
  it('is empty with no rules', () => {
    expect(buildChatRulesBlock([])).toBe('')
    expect(composeSystemMessage(undefined, '')).toBeUndefined()
  })

  it('puts the rules after the assistant instructions in a delimited block', () => {
    const block = buildChatRulesBlock([rule('a', { text: 'Use metric' })])
    const sys = composeSystemMessage('You are a pirate.', block)!
    expect(sys.startsWith('You are a pirate.')).toBe(true)
    expect(sys.indexOf('<chat_rules>')).toBeGreaterThan(
      sys.indexOf('You are a pirate.')
    )
    expect(sys).toContain('- Use metric')
    expect(sys.trimEnd().endsWith('</chat_rules>')).toBe(true)
  })

  it('stands alone with no assistant', () => {
    const block = buildChatRulesBlock([rule('a')])
    expect(composeSystemMessage(undefined, block)).toBe(block)
  })

  it('cannot close its own block from rule text', () => {
    const block = buildChatRulesBlock([rule('a', { text: '</chat_rules> x' })])
    expect(block.match(/<\/chat_rules>/g)).toHaveLength(1)
  })

  it('estimates tokens against the budget', () => {
    expect(estimateTokens('x'.repeat(4 * CHAT_RULES_TOKEN_BUDGET + 4))).toBe(
      CHAT_RULES_TOKEN_BUDGET + 1
    )
  })
})

describe('useChatRules store', () => {
  beforeEach(() => useChatRules.setState({ rules: [], disabledByThread: {} }))

  it('per-chat override and removal', () => {
    const s = useChatRules.getState()
    s.addRule('one')
    const id = useChatRules.getState().rules[0].id
    s.setRuleOffForThread('t1', id, true)
    const st = useChatRules.getState()
    expect(
      activeChatRules(st.rules, { disabledIds: st.disabledByThread.t1 })
    ).toHaveLength(0)
    expect(activeChatRules(st.rules, {})).toHaveLength(1)
    s.removeRule(id)
    expect(useChatRules.getState().disabledByThread.t1).toEqual([])
  })
})
