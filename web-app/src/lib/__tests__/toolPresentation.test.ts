import { describe, expect, it } from 'vitest'
import {
  describeNativeToolCall,
  grepHighlightRegex,
  parseGrepOutput,
  splitGrepMatches,
  parseBashOutput,
  parseWebFetchOutput,
} from '../toolPresentation'

const search = { kind: 'web-search', detail: 'Exa' } as const
const fetchOrigin = { kind: 'web-fetch' } as const

describe('describeNativeToolCall', () => {
  it('builds a search bar from the query', () => {
    expect(describeNativeToolCall(search, 'web_search', { query: 'rust async', count: 5 })).toEqual(
      { variant: 'search', query: 'rust async', count: 5 }
    )
  })

  // Arguments stream in a character at a time; a partial query must still show.
  it('accepts a partially streamed query', () => {
    expect(describeNativeToolCall(search, 'web_search', { query: 'rust as' })).toEqual({
      variant: 'search',
      query: 'rust as',
    })
  })

  it('yields an empty bar before any argument has arrived', () => {
    expect(describeNativeToolCall(search, 'web_search', undefined)).toEqual({
      variant: 'search',
      query: '',
    })
  })

  it('ignores a non-numeric count', () => {
    expect(describeNativeToolCall(search, 'web_search', { query: 'q', count: 'five' })).toEqual({
      variant: 'search',
      query: 'q',
    })
  })

  it('builds an address bar for web fetch', () => {
    expect(describeNativeToolCall(fetchOrigin, 'web_fetch', { url: 'https://a.dev/x' })).toEqual({
      variant: 'address',
      url: 'https://a.dev/x',
    })
  })

  it('builds a documents bar for a RAG retrieve', () => {
    expect(
      describeNativeToolCall({ kind: 'rag' }, 'retrieve', {
        query: 'refund policy',
        top_k: 4,
        file_ids: ['a', 'b'],
      })
    ).toEqual({
      variant: 'documents',
      query: 'refund policy',
      count: 4,
      fileCount: 2,
    })
  })

  it('omits absent RAG modifiers', () => {
    expect(
      describeNativeToolCall({ kind: 'rag' }, 'retrieve', { query: 'q' })
    ).toEqual({ variant: 'documents', query: 'q' })
  })

  it('has no bar for other RAG tools or for MCP', () => {
    expect(
      describeNativeToolCall({ kind: 'rag' }, 'list_attachments', {})
    ).toBeUndefined()
    expect(
      describeNativeToolCall({ kind: 'rag' }, 'get_chunks', { file_id: 'f' })
    ).toBeUndefined()
    expect(
      describeNativeToolCall({ kind: 'mcp', detail: 'fs' }, 'read_file', {})
    ).toBeUndefined()
    expect(describeNativeToolCall(undefined, 'x', {})).toBeUndefined()
  })
})

describe('parseWebFetchOutput', () => {
  it('splits the title, url and body', () => {
    const page = parseWebFetchOutput(
      'Title: Async Rust\nURL: https://a.dev/x\n\nbody text here'
    )
    expect(page).toEqual({
      title: 'Async Rust',
      url: 'https://a.dev/x',
      content: 'body text here',
      truncated: false,
    })
  })

  it('detects the truncation marker without leaking it into the body', () => {
    const page = parseWebFetchOutput(
      'Title: T\nURL: https://a.dev\n\nbody\n\n[content truncated]'
    )
    expect(page?.truncated).toBe(true)
    expect(page?.content).toBe('body')
  })

  it('keeps a multi-line body intact', () => {
    const page = parseWebFetchOutput(
      'Title: T\nURL: https://a.dev\n\nline one\n\nline two'
    )
    expect(page?.content).toBe('line one\n\nline two')
  })

  it('treats an unprefixed blob as body-only', () => {
    expect(parseWebFetchOutput('just content')).toEqual({
      content: 'just content',
      truncated: false,
    })
  })

  it('unwraps a { content } envelope', () => {
    expect(parseWebFetchOutput({ content: 'inner' })?.content).toBe('inner')
  })

  it('omits empty header values', () => {
    const page = parseWebFetchOutput('Title: \nURL: \n\nbody')
    expect(page?.title).toBeUndefined()
    expect(page?.url).toBeUndefined()
  })

  it('is undefined for a non-text payload', () => {
    expect(parseWebFetchOutput({ kind: 'web' })).toBeUndefined()
    expect(parseWebFetchOutput(undefined)).toBeUndefined()
  })
})

const agent = { kind: 'agent' } as const

describe('describeNativeToolCall for agent tools', () => {
  it('builds a terminal from the command', () => {
    expect(describeNativeToolCall(agent, 'bash', { command: 'ls -la' })).toEqual({
      variant: 'terminal',
      command: 'ls -la',
    })
  })

  // The command streams in like any other argument, so a partial one must show.
  it('accepts a partially streamed command', () => {
    expect(describeNativeToolCall(agent, 'bash', { command: 'git pu' })).toEqual({
      variant: 'terminal',
      command: 'git pu',
    })
  })

  // Polling a backgrounded run sends only job_id, so there is no command to show.
  it('marks a job poll', () => {
    expect(describeNativeToolCall(agent, 'bash', { job_id: 'bash-0' })).toEqual({
      variant: 'terminal',
      command: '',
      jobId: 'bash-0',
    })
  })

  it('leads with the pattern for find and grep, path as detail', () => {
    expect(
      describeNativeToolCall(agent, 'grep', { pattern: 'TODO', path: 'src' })
    ).toEqual({ variant: 'workspace', tool: 'grep', target: 'TODO', detail: 'src', grep: { literal: false, ignoreCase: false } })
    expect(describeNativeToolCall(agent, 'find', { pattern: '**/*.rs' })).toEqual({
      variant: 'workspace',
      tool: 'find',
      target: '**/*.rs',
    })
  })

  it('leads with the path for read and ls', () => {
    expect(describeNativeToolCall(agent, 'read', { path: 'a.txt' })).toEqual({
      variant: 'workspace',
      tool: 'read',
      target: 'a.txt',
    })
    expect(describeNativeToolCall(agent, 'ls', {})).toEqual({
      variant: 'workspace',
      tool: 'ls',
      target: '',
    })
  })

  it('leads with the name for memory and skill tools', () => {
    expect(describeNativeToolCall(agent, 'memory_read', { name: 'prefs' })).toEqual({
      variant: 'workspace',
      tool: 'memory_read',
      target: 'prefs',
    })
  })
})

describe('parseBashOutput', () => {
  it('splits the trailing exit marker off the body', () => {
    const r = parseBashOutput('total 0\nfile.txt\n[exit 0]')
    expect(r.text).toBe('total 0\nfile.txt')
    expect(r.exit).toBe(0)
    expect(r.signaled).toBe(false)
  })

  it('keeps a non-zero exit code', () => {
    const r = parseBashOutput('nope: not found\n[exit 127]')
    expect(r.text).toBe('nope: not found')
    expect(r.exit).toBe(127)
  })

  it('recognises a signal termination', () => {
    const r = parseBashOutput('partial\n[terminated by signal]')
    expect(r.text).toBe('partial')
    expect(r.signaled).toBe(true)
    expect(r.exit).toBeUndefined()
  })

  it('flags truncated output', () => {
    const r = parseBashOutput('tail lines\n[output truncated, full output at /tmp/x]\n[exit 0]')
    expect(r.truncated).toBe(true)
    expect(r.exit).toBe(0)
  })

  // The order Rust actually emits: `finish()` appends the exit marker first and
  // the truncation notice after it. Anchoring the exit match to end-of-string
  // lost the code on exactly these runs.
  it('still finds the exit code when a truncation notice follows it', () => {
    const r = parseBashOutput(
      'tail lines\n[exit 2]\n[output truncated at 100 of 900 bytes; full output ' +
        'written to /tmp/x. Use the read tool (with offset/limit) on that path]'
    )
    expect(r.exit).toBe(2)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('tail lines')
  })

  it('surfaces the sandbox hint separately from the body', () => {
    const r = parseBashOutput(
      "touch: cannot touch '/etc/x': Read-only file system\n[exit 1]\n" +
        '[sandbox: writes are limited to the workspace (/data/ws) and files under ' +
        'your home directory are not readable. Network access is disabled.]'
    )
    expect(r.exit).toBe(1)
    expect(r.text).toBe("touch: cannot touch '/etc/x': Read-only file system")
    expect(r.sandboxNote).toContain('writes are limited to the workspace')
    expect(r.sandboxNote).toContain('Network access is disabled')
  })

  it('has no sandbox note on an ordinary run', () => {
    expect(parseBashOutput('ok\n[exit 0]').sandboxNote).toBeUndefined()
  })

  // A command that prints an exit-marker-shaped line must not shadow the real one.
  it('takes the last exit marker when the output echoes one', () => {
    const r = parseBashOutput('log says [exit 0]\n[exit 3]')
    expect(r.exit).toBe(3)
    expect(r.text).toBe('log says [exit 0]')
  })

  it('strips notices from a signalled run too', () => {
    const r = parseBashOutput(
      'partial\n[terminated by signal]\n[sandbox: writes are limited to X.]'
    )
    expect(r.signaled).toBe(true)
    expect(r.text).toBe('partial')
    expect(r.sandboxNote).toBe('writes are limited to X.')
  })

  // Mid-run there is no marker yet; the body is whatever has arrived.
  it('leaves an unfinished run without an exit code', () => {
    const r = parseBashOutput('still going')
    expect(r.text).toBe('still going')
    expect(r.exit).toBeUndefined()
    expect(r.signaled).toBe(false)
  })

  it('takes the unsandboxed-rerun note off the output and flags it', () => {
    const r = parseBashOutput(
      "[The sandboxed run failed because Windows' null device refuses sandboxed " +
        'programs. The user allowed this command to run outside the sandbox; ' +
        'this is the result of that run.]\nbuilt\n[exit 0]'
    )
    expect(r.ranUnsandboxed).toBe(true)
    expect(r.text).toBe('built')
    expect(r.exit).toBe(0)
    expect(parseBashOutput('built\n[exit 0]').ranUnsandboxed).toBe(false)
  })

  it('handles a wrapped content payload and no output at all', () => {
    expect(parseBashOutput({ content: 'hi\n[exit 0]' }).text).toBe('hi')
    expect(parseBashOutput(undefined).text).toBe('')
    expect(parseBashOutput(undefined).exit).toBeUndefined()
  })
})

describe('grep output', () => {
  const out = [
    'src/a.ts',
    '  1- ctx',
    '  2: const foo = 1',
    '  --',
    '  9: foo()',
    '',
    'b.rs',
    '  4: fn foo() {}',
    '',
    '[Showing first 3 of 3+ matches; narrow the pattern]',
  ].join('\n')

  it('parses groups, line numbers, gaps and notes', () => {
    const parsed = parseGrepOutput(out)!
    expect(parsed.groups.map((g) => g.file)).toEqual(['src/a.ts', 'b.rs'])
    expect(parsed.groups[0].lines).toEqual([
      { line: 1, match: false, text: 'ctx' },
      { line: 2, match: true, text: 'const foo = 1' },
      { line: 9, match: true, text: 'foo()' },
    ])
    expect(parsed.groups[0].gaps).toEqual([2])
    expect(parsed.notes[0]).toMatch(/^Showing first 3 of 3\+/)
  })

  it('falls back on non-grouped text', () => {
    expect(parseGrepOutput('No matches.')).toBeUndefined()
    expect(parseGrepOutput('ERROR: invalid pattern: x')).toBeUndefined()
    expect(parseGrepOutput('a.ts:1:foo')).toBeUndefined()
  })

  it('highlights matches, honouring literal and ignore-case', () => {
    const re = grepHighlightRegex('fo+', { literal: false, ignoreCase: true })
    expect(splitGrepMatches('x FOO y foo', re)).toEqual([
      { text: 'x ', hit: false },
      { text: 'FOO', hit: true },
      { text: ' y ', hit: false },
      { text: 'foo', hit: true },
    ])
    const lit = grepHighlightRegex('a.b', { literal: true, ignoreCase: false })
    expect(splitGrepMatches('axb a.b', lit)).toEqual([
      { text: 'axb ', hit: false },
      { text: 'a.b', hit: true },
    ])
  })

  it('returns no regex for invalid or empty-matching patterns', () => {
    expect(grepHighlightRegex('(', { literal: false, ignoreCase: false })).toBeUndefined()
    expect(grepHighlightRegex('(?i)foo', { literal: false, ignoreCase: false })).toBeUndefined()
    expect(grepHighlightRegex('x*', { literal: false, ignoreCase: false })).toBeUndefined()
    expect(splitGrepMatches('abc', undefined)).toEqual([{ text: 'abc', hit: false }])
  })
})
