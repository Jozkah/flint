import { describe, it, expect } from 'vitest'
import {
  findMarker,
  parseTextToolCalls,
  partialMarkerLength,
} from '../textToolCalls'

const FENCE = '```'

describe('parseTextToolCalls: Gemma tool_code', () => {
  it('parses keyword arguments of a fenced python call', () => {
    const out = parseTextToolCalls(
      `${FENCE}tool_code\nget_weather(city="Paris", days=3, metric=True, tags=['a', "b"])\n${FENCE}\nDone.`
    )
    expect(out?.calls).toEqual([
      {
        name: 'get_weather',
        args: { city: 'Paris', days: 3, metric: true, tags: ['a', 'b'] },
      },
    ])
    expect(out?.rest).toBe('Done.')
  })

  it('unwraps print() and a module prefix, and accepts an unclosed fence', () => {
    const out = parseTextToolCalls(
      `${FENCE}tool_code\nprint(default_api.search(query="a, b (c)"))`
    )
    expect(out?.calls).toEqual([{ name: 'search', args: { query: 'a, b (c)' } }])
  })

  it('rejects positional arguments and non-calls', () => {
    expect(parseTextToolCalls(`${FENCE}tool_code\nsearch("x")\n${FENCE}`)).toBeNull()
    expect(parseTextToolCalls(`${FENCE}tool_code\nx = 1\n${FENCE}`)).toBeNull()
  })

  it('is a marker', () => {
    expect(findMarker(`ok ${FENCE}tool_code\nf()`)).toBe(3)
    expect(partialMarkerLength(`ok ${FENCE}tool_`)).toBe(8)
  })
})
