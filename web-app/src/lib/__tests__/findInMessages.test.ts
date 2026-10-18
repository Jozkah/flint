// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { findInMessages, rangesInElements } from '../findInMessages'

const msg = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown) =>
  ({ id, role, parts, metadata }) as unknown as UIMessage

describe('findInMessages', () => {
  const messages = [
    msg('u1', 'user', [{ type: 'text', text: 'How do I cache the Locale key?' }]),
    msg('a1', 'assistant', [
      { type: 'reasoning', text: 'locale thoughts' },
      { type: 'text', text: 'Include the locale in the key. The LOCALE differs.' },
      { type: 'tool-bash', input: { cmd: 'locale' }, output: 'locale' },
    ]),
    msg('s1', 'user', [{ type: 'text', text: 'locale (summary)' }], { hidden: true }),
  ]

  it('finds every case-insensitive occurrence in text parts, in order', () => {
    const found = findInMessages(messages, 'locale')
    expect(found.map((m) => [m.messageId, m.ordinal])).toEqual([
      ['u1', 0],
      ['a1', 0],
      ['a1', 1],
    ])
    expect(found[0]).toMatchObject({ partIndex: 0, start: 19, length: 6 })
  })

  it('skips reasoning, tool parts and hidden messages', () => {
    const found = findInMessages(messages, 'locale')
    expect(found.some((m) => m.messageId === 's1')).toBe(false)
    expect(found.every((m) => m.partIndex !== 0 || m.messageId === 'u1')).toBe(true)
  })

  it('returns nothing for an empty query and reads the query literally', () => {
    expect(findInMessages(messages, '   ')).toEqual([])
    expect(findInMessages([msg('x', 'user', [{ type: 'text', text: 'a.b a+b' }])], 'a.b')).toHaveLength(1)
    expect(findInMessages([msg('x', 'user', [{ type: 'text', text: 'abc' }])], 'a.c')).toEqual([])
  })
})

describe('rangesInElements', () => {
  it('finds the query across the rendered text nodes', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p>Foo <b>foo</b> bar</p><p>FOO</p>'
    const ranges = rangesInElements([host], 'foo')
    expect(ranges.map((r) => r.toString())).toEqual(['Foo', 'foo', 'FOO'])
  })
})
