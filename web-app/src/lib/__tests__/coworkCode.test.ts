import { describe, expect, it } from 'vitest'
import {
  closeTab,
  codeRefBlock,
  codeRefToken,
  detectLanguage,
  emptyCodePanelState,
  expandCodeRefs,
  focusTab,
  isSourcePath,
  isTabStale,
  lineRangeOfSlice,
  openTab,
  sandboxTabPath,
  writeCountsByPath,
  relativeToRoot,
  shouldOpenInCode,
  toggleDir,
} from '@/lib/coworkCode'
import { resolveInRoot } from '@/lib/coworkPreview'

describe('detectLanguage', () => {
  it('maps common extensions to Shiki ids', () => {
    expect(detectLanguage('src/example.ts')).toEqual({
      lang: 'typescript',
      label: 'TypeScript',
    })
    expect(detectLanguage('a/b/Component.tsx').lang).toBe('tsx')
    expect(detectLanguage('main.rs').lang).toBe('rust')
    expect(detectLanguage('script.py').lang).toBe('python')
    expect(detectLanguage('style.scss').lang).toBe('scss')
    expect(detectLanguage('query.sql').lang).toBe('sql')
  })

  it('detects special names without extensions', () => {
    expect(detectLanguage('Dockerfile').lang).toBe('dockerfile')
    expect(detectLanguage('sub/Makefile').lang).toBe('makefile')
    expect(detectLanguage('CMakeLists.txt').lang).toBe('cmake')
  })

  it('falls back to plaintext for unknown extensions', () => {
    expect(detectLanguage('notes.xyz')).toEqual({
      lang: 'text',
      label: 'Plain text',
    })
    expect(detectLanguage('no-extension').lang).toBe('text')
  })

  it('is case-insensitive on the extension', () => {
    expect(detectLanguage('MAIN.RS').lang).toBe('rust')
  })
})

describe('isSourcePath / shouldOpenInCode', () => {
  it('classifies source files', () => {
    expect(isSourcePath('a.ts')).toBe(true)
    expect(isSourcePath('a.go')).toBe(true)
    expect(isSourcePath('readme.txt')).toBe(true)
    expect(isSourcePath('yarn.lock')).toBe(true)
  })

  it('rejects binaries and unknowns', () => {
    expect(isSourcePath('logo.png')).toBe(false)
    expect(isSourcePath('app.exe')).toBe(false)
    expect(isSourcePath('archive.zip')).toBe(false)
  })

  it('routes plain-text source to Code, rendered kinds to preview', () => {
    expect(shouldOpenInCode('src/example.ts')).toBe(true)
    expect(shouldOpenInCode('main.go')).toBe(true)
    expect(shouldOpenInCode('lib.rs')).toBe(true)
    // Rendered by the preview pane — must keep going there.
    expect(shouldOpenInCode('page.html')).toBe(false)
    expect(shouldOpenInCode('chart.svg')).toBe(false)
    expect(shouldOpenInCode('README.md')).toBe(false)
    expect(shouldOpenInCode('photo.png')).toBe(false)
    expect(shouldOpenInCode('video.mp4')).toBe(false)
  })
})

describe('project-root containment (resolveInRoot)', () => {
  const root = '/home/user/project'

  it('accepts in-root relative and absolute paths', () => {
    expect(resolveInRoot(root, 'src/a.ts')).toBe('/home/user/project/src/a.ts')
    expect(resolveInRoot(root, '/home/user/project/src/a.ts')).toBe(
      '/home/user/project/src/a.ts'
    )
  })

  it('rejects .. traversal', () => {
    expect(resolveInRoot(root, '../secrets.txt')).toBeNull()
    expect(resolveInRoot(root, 'src/../../etc/passwd')).toBeNull()
  })

  it('rejects absolute paths outside the root', () => {
    expect(resolveInRoot(root, '/etc/passwd')).toBeNull()
    // Sibling with the root as a string prefix must not pass.
    expect(resolveInRoot(root, '/home/user/project-evil/x')).toBeNull()
  })
})

describe('relativeToRoot', () => {
  it('strips the root prefix', () => {
    expect(relativeToRoot('/home/u/proj', '/home/u/proj/src/a.ts')).toBe(
      'src/a.ts'
    )
  })
  it('is case-insensitive like the containment check', () => {
    expect(relativeToRoot('/Home/U/Proj', '/home/u/proj/src/a.ts')).toBe(
      'src/a.ts'
    )
  })
  it('returns outside paths unchanged', () => {
    expect(relativeToRoot('/home/u/proj', '/etc/hosts')).toBe('/etc/hosts')
    expect(relativeToRoot(null, 'x/y.ts')).toBe('x/y.ts')
  })
})

describe('tab state', () => {
  it('opens a file and focuses it', () => {
    const s = openTab(emptyCodePanelState(), 'a.ts')
    expect(s.openPaths).toEqual(['a.ts'])
    expect(s.activePath).toBe('a.ts')
  })

  it('focuses instead of duplicating an already-open file', () => {
    let s = openTab(openTab(emptyCodePanelState(), 'a.ts'), 'b.ts')
    s = openTab(s, 'a.ts')
    expect(s.openPaths).toEqual(['a.ts', 'b.ts'])
    expect(s.activePath).toBe('a.ts')
  })

  it('closing the active tab focuses the neighbour', () => {
    let s = emptyCodePanelState()
    for (const p of ['a.ts', 'b.ts', 'c.ts']) s = openTab(s, p)
    s = focusTab(s, 'b.ts')
    s = closeTab(s, 'b.ts')
    expect(s.openPaths).toEqual(['a.ts', 'c.ts'])
    expect(s.activePath).toBe('c.ts')
  })

  it('closing the last tab clears the active path', () => {
    let s = openTab(emptyCodePanelState(), 'a.ts')
    s = closeTab(s, 'a.ts')
    expect(s.openPaths).toEqual([])
    expect(s.activePath).toBeNull()
  })

  it('closing an inactive tab keeps focus where it was', () => {
    let s = openTab(openTab(emptyCodePanelState(), 'a.ts'), 'b.ts')
    s = closeTab(s, 'a.ts')
    expect(s.activePath).toBe('b.ts')
  })

  it('closing an unknown path is a no-op', () => {
    const s = openTab(emptyCodePanelState(), 'a.ts')
    expect(closeTab(s, 'zzz.ts')).toBe(s)
  })

  it('toggleDir expands and collapses', () => {
    let s = toggleDir(emptyCodePanelState(), 'src')
    expect(s.expandedDirs).toEqual(['src'])
    s = toggleDir(s, 'src')
    expect(s.expandedDirs).toEqual([])
  })
})

describe('staleness', () => {
  const write = (path: string, over = {}) => ({
    role: 'tool' as const,
    content: '',
    name: 'write',
    args: { path },
    status: 'done' as const,
    ...over,
  })

  it('counts completed writes and edits per path', () => {
    const counts = writeCountsByPath([
      write('a.ts'),
      write('a.ts', { name: 'edit' }),
      write('b.ts'),
      { role: 'assistant', content: 'chatter' },
    ])
    expect(counts).toEqual({ 'a.ts': 2, 'b.ts': 1 })
  })

  it('ignores calls that changed nothing', () => {
    expect(
      writeCountsByPath([
        write('a.ts', { status: 'running' }),
        write('b.ts', { isError: true }),
        write('c.ts', { name: 'read' }),
        write(''),
      ])
    ).toEqual({})
  })

  it('reports a tab stale only once its path is written again', () => {
    const counts = { 'a.ts': 2 }
    expect(isTabStale('a.ts', 2, counts)).toBe(false)
    expect(isTabStale('a.ts', 1, counts)).toBe(true)
    // Never loaded: nothing to be stale against.
    expect(isTabStale('a.ts', undefined, counts)).toBe(false)
    // A different file's writes do not touch this one.
    expect(isTabStale('b.ts', 0, counts)).toBe(false)
  })

  it('compares a sandbox tab on its display path', () => {
    expect(isTabStale(sandboxTabPath('out.ts'), 0, { 'out.ts': 1 })).toBe(true)
  })
})

describe('code references', () => {
  it('formats the visible token', () => {
    expect(codeRefToken({ path: 'src/example.ts', startLine: 24, endLine: 48 })).toBe(
      '@src/example.ts:24-48'
    )
    expect(codeRefToken({ path: 'a.py', startLine: 7, endLine: 7 })).toBe('@a.py:7')
  })

  it('computes 1-based line ranges from selection offsets', () => {
    const content = 'one\ntwo\nthree\nfour\n'
    // "two\nthree" — chars 4..13
    expect(lineRangeOfSlice(content, 4, 13)).toEqual({ startLine: 2, endLine: 3 })
    // Whole first line including its newline still ends on line 1.
    expect(lineRangeOfSlice(content, 0, 4)).toEqual({ startLine: 1, endLine: 1 })
    // Reversed offsets are normalized.
    expect(lineRangeOfSlice(content, 13, 4)).toEqual({ startLine: 2, endLine: 3 })
    // Empty selection collapses to one line.
    expect(lineRangeOfSlice(content, 5, 5)).toEqual({ startLine: 2, endLine: 2 })
  })

  it('builds a fenced block with path, range and language', () => {
    const block = codeRefBlock({
      path: 'src/example.ts',
      startLine: 24,
      endLine: 48,
      code: 'const x = 1\n',
    })
    expect(block).toContain('src/example.ts (lines 24-48)')
    expect(block).toContain('```typescript')
    expect(block).toContain('const x = 1')
  })

  it('expands only references whose token survived editing', () => {
    const kept = {
      path: 'a.ts',
      startLine: 1,
      endLine: 2,
      code: 'let a\nlet b',
    }
    const deleted = { path: 'b.ts', startLine: 3, endLine: 4, code: 'x' }
    const text = `Explain @a.ts:1-2 please`
    const expanded = expandCodeRefs(text, [kept, deleted])
    expect(expanded).toContain('Explain @a.ts:1-2 please')
    expect(expanded).toContain('a.ts (lines 1-2)')
    expect(expanded).not.toContain('b.ts (lines 3-4)')
  })

  it('returns the text untouched with no surviving refs', () => {
    expect(expandCodeRefs('hello', [])).toBe('hello')
  })
})
