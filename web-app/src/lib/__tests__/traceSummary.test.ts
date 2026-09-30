import { describe, expect, it } from 'vitest'
import { summarizeTrace, summaryPhrases } from '../traceSummary'

const tool = (name: string, input: unknown = {}, state = 'output-available') => ({
  type: `tool-${name}`,
  state,
  input,
})

describe('summarizeTrace', () => {
  it('counts commands, files and other tools, with line totals', () => {
    const s = summarizeTrace([
      tool('bash', { command: 'ls' }),
      tool('bash', { command: 'pwd' }),
      tool('write', { path: 'a.ts', content: 'one\ntwo\nthree\n' }),
      tool('write', { path: 'b.ts', content: 'x' }),
      tool('edit', { path: 'a.ts', edits: [{ old_string: 'a\nb', new_string: 'c' }] }),
      tool('edit', { path: 'a.ts', edits: [{ old_string: 'c', new_string: 'd\ne' }] }),
      tool('read', { path: 'a.ts' }),
      tool('grep', { pattern: 'x' }),
      tool('web_search', { query: 'q' }),
      { type: 'text' },
    ])
    expect(s).toEqual({
      commands: 2, created: 2, edited: 1, read: 1, searched: 1, tools: 1,
      added: 3 + 1 + 1 + 2, removed: 2 + 1,
    })
  })

  it('ignores failed calls', () => {
    const s = summarizeTrace([tool('bash', {}, 'output-error'), tool('write', { path: 'a', content: 'x' }, 'output-denied')])
    expect(summaryPhrases(s)).toEqual([])
  })
})

describe('summaryPhrases', () => {
  it('lists only what happened, in reading order', () => {
    const s = summarizeTrace([tool('write', { path: 'a', content: 'x' }), tool('bash', {})])
    expect(summaryPhrases(s).map((p) => p.key)).toEqual(['commands', 'created'])
  })
})
