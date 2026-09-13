import { describe, it, expect } from 'vitest'
import { diffContext, previousSnapshot } from '@/lib/contextDiff'

const sys = (text: string) => ({ role: 'system', content: text })
const user = (text: string) => ({ role: 'user', content: text })
const asst = (text: string) => ({ role: 'assistant', content: text })
const call = (id: string, name: string) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
})
const result = (id: string, text: string) => ({ role: 'tool', tool_call_id: id, content: text })
const tool = (name: string) => ({ type: 'function', function: { name, parameters: {} } })

describe('diffContext', () => {
  it('names what a follow-up request added, and why', () => {
    const before = { messages: [sys('You are Jan.'), user('list files')], tools: [tool('ls')] }
    const after = {
      messages: [sys('You are Jan.'), user('list files'), call('c1', 'ls'), result('c1', 'a.txt'), user('now read a.txt')],
      tools: [tool('ls'), tool('read')],
    }
    const d = diffContext(before, after)
    expect(d.left).toEqual([])
    expect(d.keptMessages).toBe(1)
    expect(d.entered.map((e) => e.reason)).toEqual([
      "the model's tool call from the previous step",
      'a tool result',
      'the new request',
      'offered to the model',
    ])
    expect(d.entered.at(-1)).toMatchObject({ part: 'tool', label: 'read' })
    expect(d.systemChanged).toBe(false)
  })

  it('says what left the window when older turns were trimmed', () => {
    const before = { messages: [sys('S'), user('one'), asst('1'), user('two'), asst('2')] }
    const after = { messages: [sys('S'), user('two'), asst('2'), user('three')] }
    const d = diffContext(before, after)
    expect(d.left.map((l) => l.preview)).toEqual(['one', '1'])
    expect(d.left.every((l) => l.reason.startsWith('left the window'))).toBe(true)
    expect(d.keptMessages).toBe(2)
  })

  it('tells recalled memory and instruction changes apart in the system prompt', () => {
    const before = { messages: [sys('You are Jan.\n\nJAN.md: use yarn'), user('a')] }
    const after = {
      messages: [
        sys('You are Jan.\n\n<remembered_facts>\n[mem-1] (session) likes teal\n</remembered_facts>\n\nJAN.md: use pnpm'),
        user('a'),
      ],
    }
    const d = diffContext(before, after)
    expect(d.systemChanged).toBe(true)
    const reasons = d.entered.filter((e) => e.part === 'system').map((e) => e.reason)
    expect(reasons).toContain('memory recalled for this request')
    expect(reasons).toContain('project instructions added or changed')
    expect(d.left.filter((e) => e.part === 'system').map((e) => e.reason)).toEqual([
      'project instructions removed or changed',
    ])
  })

  it('treats two messages with the same text but a different call as different', () => {
    const before = { messages: [result('c1', 'ok')] }
    const after = { messages: [result('c2', 'ok')] }
    const d = diffContext(before, after)
    expect(d.entered).toHaveLength(1)
    expect(d.left).toHaveLength(1)
  })

  it('copes with payloads that carry no messages', () => {
    expect(diffContext(null, { messages: [user('x')] }).entered).toHaveLength(1)
    expect(diffContext({}, {})).toMatchObject({ entered: [], left: [], keptMessages: 0 })
  })

  it('bounds previews', () => {
    const d = diffContext({ messages: [] }, { messages: [user('x'.repeat(1000))] })
    expect(d.entered[0].preview.length).toBeLessThanOrEqual(161)
  })
})

describe('previousSnapshot', () => {
  it('finds the snapshot sent just before, in time order', () => {
    const list = [
      { id: 'b', at: '2026-09-11T10:00:02Z' },
      { id: 'a', at: '2026-09-11T10:00:01Z' },
      { id: 'c', at: '2026-09-11T10:00:03Z' },
    ]
    expect(previousSnapshot(list, 'c')?.id).toBe('b')
    expect(previousSnapshot(list, 'a')).toBeUndefined()
    expect(previousSnapshot(list, 'zzz')).toBeUndefined()
  })
})
