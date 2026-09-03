import { describe, expect, it } from 'vitest'
import {
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  activeTab,
  neighbourTabId,
  originLabel,
  projectKeyOf,
  projectTab,
  pruneTabsForProject,
  sandboxTab,
  artifactTab,
  originScope,
  tabBelongsToProject,
  tabBelongsToSession,
  tabId,
  isWritableOrigin,
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
  writeCountsByPath,
  relativeToRoot,
  shouldOpenInCode,
  toggleDir,
} from '@/lib/coworkCode'

/** The session a sandbox tab belongs to; its identity is part of the tab id. */
const SESSION = 'session-1'
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

describe('project identity', () => {
  it('normalises a folder into a stable key across platforms', () => {
    expect(projectKeyOf('/home/u/Proj')).toBe('/home/u/proj')
    expect(projectKeyOf('/home/u/proj/')).toBe('/home/u/proj')
    expect(projectKeyOf('C:\\Users\\me\\Proj')).toBe('c:/users/me/proj')
    expect(projectKeyOf('\\\\server\\share\\Proj')).toBe(
      '//server/share/proj'
    )
    expect(projectKeyOf(null)).toBeNull()
    expect(projectKeyOf('')).toBeNull()
  })

  it('gives the same file in two projects different tab ids', () => {
    const a = projectTab('src/index.ts', '/a')
    const b = projectTab('src/index.ts', '/b')
    expect(tabId(a)).not.toBe(tabId(b))
  })

  it('distinguishes a project file from a sandbox file of the same path', () => {
    expect(tabId(projectTab('out.ts', '/a'))).not.toBe(
      tabId(sandboxTab('out.ts', SESSION))
    )
  })

  it('treats no origin as writable', () => {
    // The code surface is read-only; a future writable origin has to change
    // this deliberately rather than by omission.
    for (const origin of [
      { kind: 'project', projectKey: '/a' } as const,
      { kind: 'sandbox' } as const,
      { kind: 'artifact' } as const,
      { kind: 'external' } as const,
    ]) {
      expect(isWritableOrigin(origin)).toBe(false)
    }
  })

  it('describes each origin to the model without claiming project ownership', () => {
    expect(originLabel({ kind: 'project', projectKey: '/a' })).toContain(
      'attached project'
    )
    expect(originLabel({ kind: 'sandbox' })).toContain('workspace')
    expect(originLabel({ kind: 'artifact' })).toContain('generated')
    expect(originLabel({ kind: 'external' })).toContain('external')
    // None of the non-project origins may read as the user's project.
    for (const origin of [
      { kind: 'sandbox' } as const,
      { kind: 'artifact' } as const,
      { kind: 'external' } as const,
    ]) {
      expect(originLabel(origin)).not.toContain('attached project')
    }
  })
})

describe('tab state', () => {
  const A = '/proj-a'
  const B = '/proj-b'

  it('opens a file and focuses it', () => {
    const tab = projectTab('a.ts', A)
    const s = openTab(emptyCodePanelState(), tab)
    expect(s.tabs).toEqual([tab])
    expect(s.activeTabId).toBe(tabId(tab))
  })

  it('focuses instead of duplicating an already-open file', () => {
    const a = projectTab('a.ts', A)
    const b = projectTab('b.ts', A)
    let s = openTab(openTab(emptyCodePanelState(), a), b)
    s = openTab(s, a)
    expect(s.tabs).toHaveLength(2)
    expect(s.activeTabId).toBe(tabId(a))
  })

  it('closing the active tab focuses the neighbour', () => {
    const tabs = ['a.ts', 'b.ts', 'c.ts'].map((p) => projectTab(p, A))
    let s = tabs.reduce(openTab, emptyCodePanelState())
    s = focusTab(s, tabId(tabs[1]))
    s = closeTab(s, tabId(tabs[1]))
    expect(s.tabs.map((t) => t.path)).toEqual(['a.ts', 'c.ts'])
    expect(s.activeTabId).toBe(tabId(tabs[2]))
  })

  it('closing the last tab clears the active id', () => {
    const tab = projectTab('a.ts', A)
    const s = closeTab(openTab(emptyCodePanelState(), tab), tabId(tab))
    expect(s.tabs).toEqual([])
    expect(s.activeTabId).toBeNull()
  })

  it('closes other tabs and all tabs', () => {
    const tabs = ['a.ts', 'b.ts', 'c.ts'].map((p) => projectTab(p, A))
    const s = tabs.reduce(openTab, emptyCodePanelState())
    const others = closeOtherTabs(s, tabId(tabs[1]))
    expect(others.tabs).toEqual([tabs[1]])
    expect(others.activeTabId).toBe(tabId(tabs[1]))
    expect(closeAllTabs(s).tabs).toEqual([])
    expect(closeAllTabs(s).activeTabId).toBeNull()
  })

  it('moves between tabs for keyboard switching, wrapping at the ends', () => {
    const tabs = ['a.ts', 'b.ts'].map((p) => projectTab(p, A))
    const s = tabs.reduce(openTab, emptyCodePanelState())
    expect(neighbourTabId(s, 1)).toBe(tabId(tabs[0]))
    expect(neighbourTabId(s, -1)).toBe(tabId(tabs[0]))
    expect(neighbourTabId(emptyCodePanelState(), 1)).toBeNull()
  })

  it('drops the other project’s tabs when the project changes', () => {
    // The regression: a tab opened against A kept its bare relative path and
    // was re-resolved inside B, showing B's file of the same name.
    const fromA = projectTab('src/index.ts', A)
    const sandbox = sandboxTab('out.ts', SESSION)
    let s = openTab(openTab(emptyCodePanelState(), fromA), sandbox)
    s = toggleDir(s, 'src')

    const switched = pruneTabsForProject(s, B)
    expect(switched.tabs).toEqual([sandbox])
    expect(switched.activeTabId).toBe(tabId(sandbox))
    // The tree belonged to the project that went away.
    expect(switched.expandedDirs).toEqual([])
  })

  it('keeps session-owned tabs when the project is detached', () => {
    const fromA = projectTab('a.ts', A)
    const sandbox = sandboxTab('out.ts', SESSION)
    const s = openTab(openTab(emptyCodePanelState(), fromA), sandbox)
    const detached = pruneTabsForProject(s, null)
    expect(detached.tabs).toEqual([sandbox])
  })

  it('keeps tabs when the same project is re-attached', () => {
    const tab = projectTab('a.ts', A)
    const s = openTab(emptyCodePanelState(), tab)
    expect(pruneTabsForProject(s, A).tabs).toEqual([tab])
  })

  it('knows which tabs belong to the attached project', () => {
    expect(tabBelongsToProject(projectTab('a.ts', A), A)).toBe(true)
    expect(tabBelongsToProject(projectTab('a.ts', A), B)).toBe(false)
    expect(tabBelongsToProject(sandboxTab('a.ts', SESSION), B)).toBe(true)
    expect(tabBelongsToProject(sandboxTab('a.ts', SESSION), null)).toBe(true)
  })

  it('resolves the active tab, or nothing when it was closed', () => {
    const tab = projectTab('a.ts', A)
    const s = openTab(emptyCodePanelState(), tab)
    expect(activeTab(s)).toEqual(tab)
    expect(activeTab(closeTab(s, tabId(tab)))).toBeUndefined()
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
    const tab = projectTab('a.ts', '/proj')
    expect(isTabStale(tab, 2, counts)).toBe(false)
    expect(isTabStale(tab, 1, counts)).toBe(true)
    // Never loaded: nothing to be stale against.
    expect(isTabStale(tab, undefined, counts)).toBe(false)
    // A different file's writes do not touch this one.
    expect(isTabStale(projectTab('b.ts', '/proj'), 0, counts)).toBe(false)
  })

  it('compares a sandbox tab on its own path', () => {
    expect(isTabStale(sandboxTab('out.ts', SESSION), 0, { 'out.ts': 1 })).toBe(true)
  })
})

describe('code references', () => {
  it('formats the visible token', () => {
    expect(
      codeRefToken({ path: 'src/example.ts', startLine: 24, endLine: 48 })
    ).toBe(
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
      origin: { kind: 'project', projectKey: '/proj' },
      startLine: 24,
      endLine: 48,
      code: 'const x = 1\n',
    })
    expect(block).toContain('src/example.ts (lines 24-48)')
    expect(block).toContain('attached project')
    expect(block).toContain('```typescript')
    expect(block).toContain('const x = 1')
  })

  it('expands only references whose token survived editing', () => {
    const kept = {
      path: 'a.ts',
      origin: { kind: 'project' as const, projectKey: '/proj' },
      startLine: 1,
      endLine: 2,
      code: 'let a\nlet b',
    }
    const deleted = {
      path: 'b.ts',
      origin: { kind: 'sandbox' as const },
      startLine: 3,
      endLine: 4,
      code: 'x',
    }
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

describe('session identity', () => {
  const OTHER = 'session-2'

  it('gives the same sandbox path different ids in different sessions', () => {
    // Every session has its own workspace, so `out.ts` is a different file in
    // each. One id would mean one cache entry and one set of bytes.
    expect(tabId(sandboxTab('out.ts', SESSION))).not.toBe(
      tabId(sandboxTab('out.ts', OTHER))
    )
  })

  it('separates a sandbox tab from an artifact tab of the same path', () => {
    expect(tabId(sandboxTab('out.ts', SESSION))).not.toBe(
      tabId(artifactTab('out.ts', SESSION))
    )
  })

  it('scopes a sandbox origin by its session and a project origin by its key', () => {
    expect(originScope({ kind: 'sandbox', sessionKey: SESSION })).toBe(SESSION)
    expect(originScope({ kind: 'artifact', sessionKey: SESSION })).toBe(SESSION)
    expect(originScope({ kind: 'project', projectKey: '/p' })).toBe('/p')
    expect(originScope({ kind: 'external' })).toBe('')
  })

  it('scopes a tab persisted before the field existed to the empty string', () => {
    // What a v3 blob holds. A migration must be able to name such a tab.
    const legacy = { kind: 'sandbox' } as unknown as Parameters<
      typeof originScope
    >[0]
    expect(originScope(legacy)).toBe('')
  })

  it('claims a session-owned tab only for the session that owns it', () => {
    expect(tabBelongsToSession(sandboxTab('out.ts', SESSION), SESSION)).toBe(
      true
    )
    expect(tabBelongsToSession(sandboxTab('out.ts', SESSION), OTHER)).toBe(
      false
    )
    expect(tabBelongsToSession(artifactTab('c.svg', SESSION), OTHER)).toBe(
      false
    )
    // No session at all: nothing session-owned can be read.
    expect(tabBelongsToSession(sandboxTab('out.ts', SESSION), null)).toBe(false)
  })

  it('leaves project tabs out of the session question entirely', () => {
    // A project tab is keyed to its project, and follows the session it is
    // stored on; asking whether it belongs to a session is not meaningful.
    expect(tabBelongsToSession(projectTab('a.ts', '/p'), OTHER)).toBe(true)
    expect(tabBelongsToSession(projectTab('a.ts', '/p'), null)).toBe(true)
  })

  it('keeps a session’s own tabs when its project changes', () => {
    // Detaching or switching a project prunes project tabs; the session's own
    // files have nothing to do with the project.
    const state = openTab(
      openTab(emptyCodePanelState(), projectTab('a.ts', '/p')),
      sandboxTab('out.ts', SESSION)
    )
    expect(pruneTabsForProject(state, '/other').tabs).toEqual([
      sandboxTab('out.ts', SESSION),
    ])
  })
})
