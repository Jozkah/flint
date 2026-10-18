import { describe, expect, it } from 'vitest'
import { explainRawToolCall, fenceRawToolCalls, hasRawToolCall } from '../rawToolCallText'

it('replaces plain text tool markup with an honest failure notice', () => {
  const text =
    'Sure, let me check.\n\n<tool_call> <function=shell_run> <parameter=command> pwd </parameter> </function>\n</tool_call>'
  expect(explainRawToolCall(text)).toBe(
    'Sure, let me check.\n\nTool call was emitted as text. No tool ran. Check this model’s tool support and try again.'
  )
  expect(hasRawToolCall(text)).toBe(true)
})

it('leaves ordinary text alone', () => {
  expect(explainRawToolCall('Tool finished.')).toBe('Tool finished.')
  expect(hasRawToolCall('Tool finished.')).toBe(false)
})

describe('fenceRawToolCalls', () => {
  const call = JSON.stringify({
    name: 'edit',
    arguments: { path: 'C:\tmp\app.js', content: 'function add(a, b) { return a + b }\n' },
  })

  it('fences a bare JSON tool call as pretty-printed json', () => {
    const out = fenceRawToolCalls(call)
    expect(out.found).toBe(true)
    expect(out.text.startsWith('```json\n{\n  "name": "edit"')).toBe(true)
    expect(out.text.trimEnd().endsWith('```')).toBe(true)
  })

  it('fences <tool_call> blocks and keeps the prose around them', () => {
    const out = fenceRawToolCalls(`I will edit it.\n<tool_call>\n${call}\n</tool_call>\nThen done.`)
    expect(out.found).toBe(true)
    expect(out.text).not.toContain('<tool_call>')
    expect(out.text).toContain('I will edit it.')
    expect(out.text).toContain('```json\n{\n  "name": "edit"')
    expect(out.text).toContain('Then done.')
  })

  it('fences an unclosed block while it streams and a function-tag body raw', () => {
    expect(fenceRawToolCalls(`<tool_call>\n{"name": "read", "argu`).text).toMatch(/^```json\n\{"name": "read", "argu\n```$/)
    const tag = fenceRawToolCalls('<tool_call><function=ls><parameter=path>.</parameter></function></tool_call>')
    expect(tag.found).toBe(true)
    expect(tag.text).toContain('```xml\n<function=ls>')
  })

  it('flags an already fenced json call without rewriting it', () => {
    const text = '```json\n' + call + '\n```'
    expect(fenceRawToolCalls(text)).toEqual({ text, found: true })
  })

  it('leaves ordinary text and ordinary JSON alone', () => {
    expect(fenceRawToolCalls('Hello {"a": 1}')).toEqual({ text: 'Hello {"a": 1}', found: false })
    expect(fenceRawToolCalls('{"a": 1}')).toEqual({ text: '{"a": 1}', found: false })
    expect(fenceRawToolCalls('```json\n{"a": 1}\n```').found).toBe(false)
  })
})
