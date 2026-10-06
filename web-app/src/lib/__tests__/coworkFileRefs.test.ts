import { describe, it, expect } from 'vitest'
import {
  parseBareFilePaths,
  isSafeRefPath,
  parseFileRefs,
  hasFileRef,
  parseFileRefHref,
  remarkFileRefs,
  FILE_REF_HREF_PREFIX,
  type RefSegment,
} from '@/lib/coworkFileRefs'

const refs = (text: string) =>
  parseFileRefs(text).filter((s): s is Extract<RefSegment, { type: 'ref' }> => s.type === 'ref')

describe('bare file paths in output', () => {
  it('finds HTML and source files while leaving URLs and prose alone', () => {
    const paths = parseBareFilePaths('Changed print_checklist.html and src/app.ts. Open https://example.com/a.ts or Node.js.')
      .filter((part) => part.type === 'path')
      .map((part) => part.text)
    expect(paths).toEqual(['print_checklist.html', 'src/app.ts'])
  })

  it('links file names in markdown text without requiring @', () => {
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [
      { type: 'text', value: 'Changed print_checklist.html' },
    ] }] }
    remarkFileRefs()(tree)
    expect(tree.children[0].children.some((node) => node.type === 'link')).toBe(true)
  })
})

describe('isSafeRefPath', () => {
  it('accepts relative source-like paths', () => {
    expect(isSafeRefPath('src/example.ts')).toBe(true)
    expect(isSafeRefPath('a/b/c.rs')).toBe(true)
    expect(isSafeRefPath('README.md')).toBe(true) // extension, no slash
    expect(isSafeRefPath('src/nested/dir/file.tsx')).toBe(true)
  })

  it('rejects traversal, absolute, drive, UNC, and URL-ish paths', () => {
    expect(isSafeRefPath('../etc/passwd')).toBe(false)
    expect(isSafeRefPath('a/../b.ts')).toBe(false)
    expect(isSafeRefPath('/etc/passwd')).toBe(false)
    expect(isSafeRefPath('C:/Windows/system32')).toBe(false)
    expect(isSafeRefPath('//server/share/x.ts')).toBe(false)
    expect(isSafeRefPath('https://example.com/x.ts')).toBe(false)
    expect(isSafeRefPath('src\\win\\path.ts')).toBe(false)
  })

  it('rejects non-file-looking and directory paths', () => {
    expect(isSafeRefPath('everyone')).toBe(false) // no slash, no ext
    expect(isSafeRefPath('media')).toBe(false)
    expect(isSafeRefPath('src/')).toBe(false) // trailing slash
    expect(isSafeRefPath('')).toBe(false)
  })
})

describe('parseFileRefs', () => {
  it('detects an explicit @path reference', () => {
    const r = refs('open @src/example.ts please')
    expect(r).toHaveLength(1)
    expect(r[0].ref.path).toBe('src/example.ts')
    expect(r[0].ref.line).toBeUndefined()
  })

  it('detects a line and a line range', () => {
    expect(refs('see @src/a.ts:24')[0].ref).toMatchObject({
      path: 'src/a.ts',
      line: 24,
    })
    expect(refs('see @src/a.ts:24-48')[0].ref).toMatchObject({
      path: 'src/a.ts',
      line: 24,
      endLine: 48,
    })
  })

  it('drops a backwards range but keeps the file and start line', () => {
    const r = refs('@src/a.ts:48-24')[0].ref
    expect(r.path).toBe('src/a.ts')
    expect(r.line).toBe(48)
    expect(r.endLine).toBeUndefined()
  })

  it('does NOT linkify a bare path without the @ marker', () => {
    expect(hasFileRef('the file src/example.ts changed')).toBe(false)
  })

  it('does NOT match inside emails or user@host', () => {
    expect(hasFileRef('mail me at jan@example.com')).toBe(false)
    expect(hasFileRef('ssh git@github.com/x.ts')).toBe(false)
  })

  it('does NOT match inside URLs', () => {
    expect(hasFileRef('https://example.com/@src/x.ts')).toBe(false)
    expect(hasFileRef('(https://a.co/u@h/p.ts)')).toBe(false)
  })

  it('rejects a traversal reference even with the @ marker', () => {
    expect(hasFileRef('bad @../secret.ts here')).toBe(false)
    expect(hasFileRef('bad @/etc/passwd here')).toBe(false)
  })

  it('does not swallow trailing sentence punctuation', () => {
    const segs = parseFileRefs('edit @src/a.ts.')
    const ref = segs.find((s) => s.type === 'ref') as Extract<
      RefSegment,
      { type: 'ref' }
    >
    expect(ref.ref.path).toBe('src/a.ts')
    expect(segs[segs.length - 1]).toEqual({ type: 'text', text: '.' })
  })

  it('handles a reference at the very start of the text', () => {
    expect(refs('@src/a.ts is here')[0].ref.path).toBe('src/a.ts')
  })

  it('detects duplicate references independently', () => {
    const r = refs('@src/a.ts and again @src/a.ts:2')
    expect(r).toHaveLength(2)
    expect(r[0].ref.line).toBeUndefined()
    expect(r[1].ref.line).toBe(2)
  })

  it('preserves surrounding text as segments', () => {
    const segs = parseFileRefs('before @a/b.ts after')
    expect(segs[0]).toEqual({ type: 'text', text: 'before ' })
    expect(segs[1].type).toBe('ref')
    expect(segs[2]).toEqual({ type: 'text', text: ' after' })
  })

  it('returns a single text segment when there is nothing to link', () => {
    expect(parseFileRefs('just words')).toEqual([
      { type: 'text', text: 'just words' },
    ])
    expect(parseFileRefs('')).toEqual([])
  })
})

describe('parseFileRefHref', () => {
  it('round-trips an encoded reference through the fragment href', () => {
    const href = `${FILE_REF_HREF_PREFIX}${encodeURIComponent('src/a.ts:10-20')}`
    expect(parseFileRefHref(href)).toEqual({
      raw: 'src/a.ts:10-20',
      path: 'src/a.ts',
      line: 10,
      endLine: 20,
    })
  })

  it('rejects hrefs that are not ours', () => {
    expect(parseFileRefHref('#cite-1')).toBeNull()
    expect(parseFileRefHref('https://example.com')).toBeNull()
    expect(parseFileRefHref(undefined)).toBeNull()
  })

  it('re-validates the decoded path (defense in depth)', () => {
    expect(
      parseFileRefHref(`${FILE_REF_HREF_PREFIX}${encodeURIComponent('../x.ts')}`)
    ).toBeNull()
    expect(
      parseFileRefHref(
        `${FILE_REF_HREF_PREFIX}${encodeURIComponent('/etc/passwd')}`
      )
    ).toBeNull()
  })
})

describe('remarkFileRefs inline-code paths', () => {
  type N = { type: string; value?: string; url?: string; children?: N[] }
  const run = (children: N[]) => {
    const tree: N = { type: 'root', children: [{ type: 'paragraph', children }] }
    remarkFileRefs()(tree)
    return tree.children![0].children!
  }

  it('links a whole inline-code span that is a path, keeping the code node', () => {
    const [node] = run([{ type: 'inlineCode', value: 'src/a.ts:12' }])
    expect(node.type).toBe('link')
    expect(node.url).toMatch(/^#coworkpath-/)
    expect(node.children).toEqual([{ type: 'inlineCode', value: 'src/a.ts:12' }])
  })

  it('leaves non-path code spans and prose alone', () => {
    for (const v of ['npm install', 'v1.2.3', 'e.g.', 'foo.bar()']) {
      expect(run([{ type: 'inlineCode', value: v }])[0].type, v).toBe('inlineCode')
    }
    // A file named in prose becomes a link.
    expect(run([{ type: 'text', value: 'edit src/a.ts now' }])).toEqual([
      { type: 'text', value: 'edit ' },
      { type: 'link', url: '#coworkpath-src%2Fa.ts', children: [{ type: 'text', value: 'src/a.ts' }] },
      { type: 'text', value: ' now' },
    ])
  })

  it('does not nest links inside existing links', () => {
    const tree: N = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'link', url: 'https://x', children: [{ type: 'inlineCode', value: 'src/a.ts' }] },
          ],
        },
      ],
    }
    remarkFileRefs()(tree)
    expect(tree.children![0].children![0].children![0].type).toBe('inlineCode')
  })
})
