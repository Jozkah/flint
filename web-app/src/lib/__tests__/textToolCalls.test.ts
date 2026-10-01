import { describe, expect, it } from 'vitest'
import {
  findMarker,
  parseTextToolCalls,
  partialMarkerLength,
} from '@/lib/textToolCalls'

describe('parseTextToolCalls', () => {
  it('parses Hermes / Qwen 2.5 JSON', () => {
    const out = parseTextToolCalls(
      '<tool_call>\n{"name":"read_file","arguments":{"path":"a.txt"}}\n</tool_call>'
    )
    expect(out?.calls).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }])
  })

  it('parses several Hermes blocks and keeps trailing text', () => {
    const out = parseTextToolCalls(
      '<tool_call>{"name":"a","arguments":{}}</tool_call>\n<tool_call>{"name":"b","arguments":{"x":1}}</tool_call> done'
    )
    expect(out?.calls.map((c) => c.name)).toEqual(['a', 'b'])
    expect(out?.rest).toBe('done')
  })

  it('accepts string-encoded arguments', () => {
    const out = parseTextToolCalls(
      '<tool_call>{"name":"a","arguments":"{\\"x\\":2}"}</tool_call>'
    )
    expect(out?.calls[0].args).toEqual({ x: 2 })
  })

  it('parses Qwen3-Coder function tags and coerces by schema', () => {
    const out = parseTextToolCalls(
      '<tool_call>\n<function=write>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=count>\n3\n</parameter>\n<parameter=note>\n007\n</parameter>\n</function>\n</tool_call>',
      { write: { count: 'integer', path: 'string', note: 'string' } }
    )
    expect(out?.calls).toEqual([
      { name: 'write', args: { path: 'src/a.ts', count: 3, note: '007' } },
    ])
  })

  it('parses GLM arg_key / arg_value blocks', () => {
    const out = parseTextToolCalls(
      '<tool_call>get_weather\n<arg_key>city</arg_key>\n<arg_value>Paris</arg_value>\n</tool_call>'
    )
    expect(out?.calls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }])
  })

  it('parses Mistral [TOOL_CALLS] arrays and the older [ARGS] form', () => {
    expect(
      parseTextToolCalls('[TOOL_CALLS][{"name":"a","arguments":{"k":"v"}}]')
        ?.calls
    ).toEqual([{ name: 'a', args: { k: 'v' } }])
    expect(parseTextToolCalls('[TOOL_CALLS]a[ARGS]{"k":"v"}')?.calls).toEqual([
      { name: 'a', args: { k: 'v' } },
    ])
  })

  it('parses Llama python_tag calls with parameters and ; separators', () => {
    const out = parseTextToolCalls(
      '<|python_tag|>{"name":"a","parameters":{"x":1}}; {"name":"b","parameters":{}}<|eom_id|>'
    )
    expect(out?.calls).toEqual([
      { name: 'a', args: { x: 1 } },
      { name: 'b', args: {} },
    ])
  })

  it('returns null for malformed or unrelated text', () => {
    expect(parseTextToolCalls('<tool_call>{"name":')).toBeNull()
    expect(parseTextToolCalls('<tool_call>not a call</tool_call>')).toBeNull()
    expect(parseTextToolCalls('plain answer')).toBeNull()
  })
})

describe('marker helpers', () => {
  it('finds the earliest marker', () => {
    expect(findMarker('hi <tool_call>x')).toBe(3)
    expect(findMarker('nothing')).toBe(-1)
  })

  it('reports how much of the tail could still become a marker', () => {
    expect(partialMarkerLength('see <tool')).toBe(5)
    expect(partialMarkerLength('see [TOOL_CAL')).toBe(9)
    expect(partialMarkerLength('see <b')).toBe(0)
    expect(partialMarkerLength('a<')).toBe(1)
  })
})
