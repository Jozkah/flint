import { describe, expect, it } from 'vitest'
import { partFailed, summarizeTrace, summaryPhrases, toolSentence } from '../traceSummary'

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
      commands: 2, created: 2, edited: 1, read: 1, searched: 1, tools: 1, failed: 0,
      added: 3 + 1 + 1 + 2, removed: 2 + 1,
    })
  })

  it('counts failures, without crediting a file that was never written', () => {
    const s = summarizeTrace([
      tool('bash', {}, 'output-error'),
      { ...tool('bash', {}), output: 'boom\n[exit 1]' },
      tool('write', { path: 'a', content: 'x' }, 'output-denied'),
    ])
    expect(s).toMatchObject({ commands: 2, created: 0, added: 0, failed: 3 })
  })

  it('treats a command that exited non-zero as failed', () => {
    expect(partFailed({ ...tool('bash'), output: 'ok\n[exit 0]' })).toBe(false)
    expect(partFailed({ ...tool('bash'), output: 'no\n[exit 2]' })).toBe(true)
  })
})

describe('summaryPhrases', () => {
  it('lists only what happened, in reading order', () => {
    const s = summarizeTrace([tool('write', { path: 'a', content: 'x' }), tool('bash', {})])
    expect(summaryPhrases(s).map((p) => p.key)).toEqual(['commands', 'created'])
  })
})

describe('toolSentence', () => {
  it('prefers the description the model wrote', () => {
    expect(toolSentence(tool('bash', { command: 'ls', description: 'Listed patch files' }))).toBe('Listed patch files')
  })

  it('builds one from the arguments otherwise', () => {
    expect(toolSentence(tool('read', { path: 'C:/a/b/AUDIT.md' }))).toBe('Read AUDIT.md')
    expect(toolSentence(tool('write', { path: 'x/notes.md' }))).toBe('Created notes.md')
    expect(toolSentence(tool('edit', { path: 'x/y.ts' }))).toBe('Edited y.ts')
    expect(toolSentence(tool('grep', { pattern: 'foo' }))).toBe('Searched for foo')
    expect(toolSentence(tool('bash', { command: 'git   status' }))).toBe('Ran git status')
    expect(toolSentence(tool('memory_read', {}))).toBe('Used memory read')
  })
})
