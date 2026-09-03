import { describe, expect, it, vi } from 'vitest'
import {
  parsePromptForReferences,
  stripPromptReferences,
  lineRangeOf,
} from '../path-references'
import { codeRefToken, expandCodeRefs } from '../coworkCode'

vi.mock('@janhq/core', () => ({
  fs: {},
}))

describe('parsePromptForReferences', () => {
  it('does not treat ssh/email addresses as references', () => {
    expect(
      parsePromptForReferences('please use bash to ssh username@44.50.0.89')
    ).toEqual([])
    expect(
      parsePromptForReferences('please use bash to ssh alandao@44.50.0.89')
    ).toEqual([])
    expect(parsePromptForReferences('mail me at foo@bar.com please')).toEqual(
      []
    )
  })

  it('does not treat bare IPv4 as a reference, even with a trailing period', () => {
    expect(parsePromptForReferences('use bash to ssh @44.50.0.89 now')).toEqual(
      []
    )
    expect(parsePromptForReferences('please ping @44.50.0.89.')).toEqual([])
  })

  it('parses references and keeps the rest of the query', () => {
    expect(
      parsePromptForReferences('use @README.md to check the build steps')
    ).toEqual(['README.md'])
    expect(parsePromptForReferences('diff @my-file.txt against main')).toEqual(
      ['my-file.txt']
    )
    expect(
      parsePromptForReferences('open @src/main.ts and (@README.md)')
    ).toEqual(['src/main.ts', 'README.md'])
  })
})

describe('stripPromptReferences', () => {
  it('strips references but keeps ssh/email addresses', () => {
    expect(
      stripPromptReferences('see @src/main.ts and ssh user@44.50.0.89')
    ).toBe('see and ssh user@44.50.0.89')
  })

  it('keeps non-reference text intact', () => {
    expect(stripPromptReferences('no refs here')).toBe('no refs here')
    expect(stripPromptReferences('ssh username@44.50.0.89')).toBe(
      'ssh username@44.50.0.89'
    )
  })
})

describe('excerpt references (@path:start-end)', () => {
  // The Cowork code viewer's "Add to chat" emits `@src/example.ts:24-48` and
  // carries the selected lines with it. The token class used to stop at the
  // `:`, so this system claimed the bare path: it stripped the reference down
  // to a dangling `:24-48`, the selected lines were dropped, and the resolver
  // went looking for `src/example.ts` under the *home directory* — putting a
  // whole unrelated file in the prompt instead of the chosen lines.

  it('does not claim a ranged reference as a file to read', () => {
    expect(
      parsePromptForReferences('explain @src/example.ts:24-48 please')
    ).toEqual([])
    expect(parsePromptForReferences('see @src/a.ts:12 there')).toEqual([])
  })

  it('leaves a ranged reference in the prompt, whole', () => {
    // Both halves matter: the token must survive for the code viewer to
    // expand it, and no `:24-48` may be left stranded in the visible text.
    const text = 'explain @src/example.ts:24-48 please'
    expect(stripPromptReferences(text)).toBe(text)
    expect(stripPromptReferences(text)).not.toContain(' :24-48')
  })

  it('still claims the plain path in the same prompt', () => {
    const text = 'compare @README.md with @src/example.ts:24-48'
    expect(parsePromptForReferences(text)).toEqual(['README.md'])
    expect(stripPromptReferences(text)).toBe(
      'compare with @src/example.ts:24-48'
    )
  })

  it('reads the range off a token', () => {
    expect(lineRangeOf('src/example.ts:24-48')).toEqual({
      path: 'src/example.ts',
      startLine: 24,
      endLine: 48,
    })
    // A single-line selection, which is what codeRefToken emits for one line.
    expect(lineRangeOf('src/a.ts:12')).toEqual({
      path: 'src/a.ts',
      startLine: 12,
      endLine: 12,
    })
    expect(lineRangeOf('src/a.ts')).toBeNull()
    // A colon that is not a line range still belongs to the path.
    expect(lineRangeOf('src/a:b.ts')).toBeNull()
  })
})

describe('code references survive the prompt round trip', () => {
  it('keeps the token so the selected code reaches the model', () => {
    // The whole point, end to end: what ChatInput hands on still contains the
    // token, so expandCodeRefs finds it and appends the selected lines. Before
    // the fix `surviving` was empty and the selection was silently discarded.
    const ref = {
      path: 'src/example.ts',
      origin: { kind: 'project' as const, projectKey: '/home/dev/project' },
      startLine: 24,
      endLine: 25,
      code: 'const a = 1\nconst b = 2',
    }
    const typed = `what does ${codeRefToken(ref)} do?`

    const forwarded = stripPromptReferences(typed)
    expect(forwarded).toContain(codeRefToken(ref))

    const forModel = expandCodeRefs(forwarded, [ref])
    expect(forModel).toContain('const a = 1')
    expect(forModel).toContain('lines 24-25')
    // And nothing pulled the rest of the file in alongside it.
    expect(parsePromptForReferences(typed)).toEqual([])
  })
})
