import { describe, expect, it } from 'vitest'
import {
  absoluteChangePath,
  resolveCodePath,
  shortToolPath,
} from '../codePathResolve'
import {
  joinToolPath,
  lineOfToolInput,
  openInBackground,
} from '../codeOpen'
import { openTabAt, emptyCodePanelState, projectTab, tabId } from '../coworkCode'

const ctx = {
  treeRoot: 'C:/work/repo',
  workspacePath: 'C:/data/sessions/s1',
  extraFolders: ['D:/other'],
  relativeIsProject: false,
  hasSession: true,
}

describe('resolving a tool path the way the tool did', () => {
  it('puts an absolute path in the tree or the sandbox', () => {
    expect(resolveCodePath('C:\\work\\repo\\src\\a.go', ctx)).toEqual({
      kind: 'project',
      rel: 'src/a.go',
    })
    expect(resolveCodePath('C:/data/sessions/s1/out.ts', ctx)).toEqual({
      kind: 'sandbox',
      rel: 'out.ts',
    })
  })

  it('puts a relative path in the sandbox, or the write root under a grant', () => {
    expect(resolveCodePath('kewscrape\\integrations\\ingestion.go', ctx)).toEqual({
      kind: 'sandbox',
      rel: 'kewscrape/integrations/ingestion.go',
    })
    expect(
      resolveCodePath('./src/a.ts', { ...ctx, relativeIsProject: true })
    ).toEqual({ kind: 'project', rel: 'src/a.ts' })
  })

  it('refuses with a reason instead of guessing', () => {
    expect(resolveCodePath('D:/other/x.ts', ctx)).toEqual({
      kind: 'unresolved',
      reason: 'extra-folder',
    })
    expect(resolveCodePath('E:/elsewhere/x.ts', ctx)).toEqual({
      kind: 'unresolved',
      reason: 'outside',
    })
    expect(resolveCodePath('logo.png', ctx)).toEqual({
      kind: 'unresolved',
      reason: 'not-source',
    })
    expect(resolveCodePath('a.ts', { ...ctx, hasSession: false })).toEqual({
      kind: 'unresolved',
      reason: 'no-session',
    })
  })
})

describe('opening helpers', () => {
  it('reads the line a call aimed at', () => {
    expect(lineOfToolInput({ path: 'a', offset: 40 })).toBe(40)
    expect(lineOfToolInput({ path: 'a', line: '7' })).toBe(7)
    expect(lineOfToolInput({ path: 'a' })).toBeUndefined()
    expect(lineOfToolInput({ offset: 0 })).toBeUndefined()
  })

  it('treats Ctrl/Cmd-click and middle-click as background opens', () => {
    expect(openInBackground({ ctrlKey: true })).toBe(true)
    expect(openInBackground({ metaKey: true })).toBe(true)
    expect(openInBackground({ button: 1 })).toBe(true)
    expect(openInBackground({ button: 0 })).toBe(false)
  })

  it('joins a listed entry to the listed directory', () => {
    expect(joinToolPath('src', 'a.ts')).toBe('src/a.ts')
    expect(joinToolPath('src/', './a.ts')).toBe('src/a.ts')
    expect(joinToolPath('src', 'C:/abs/a.ts')).toBe('C:/abs/a.ts')
    expect(joinToolPath(undefined, 'a.ts')).toBe('a.ts')
  })

  it('opens at a line, or in the background without switching', () => {
    const a = projectTab('a.ts', 'k')
    const b = projectTab('b.ts', 'k')
    const first = openTabAt(emptyCodePanelState(), a, { line: 12, now: 1 })
    expect(first.activeTabId).toBe(tabId(a))
    expect(first.reveal).toEqual({ tabId: tabId(a), line: 12, at: 1 })
    const queued = openTabAt(first, b, { background: true })
    expect(queued.tabs).toHaveLength(2)
    expect(queued.activeTabId).toBe(tabId(a))
  })
})

describe('shortToolPath', () => {
  it('shows a sandbox or project path relative to its root', () => {
    const inSandbox = 'C:/data/sessions/s1/kewscrape/integrations/ingestion.go'
    expect(shortToolPath(resolveCodePath(inSandbox, ctx), inSandbox)).toBe(
      'kewscrape/integrations/ingestion.go'
    )
    const inProject = 'C:/work/repo/src/app.ts'
    expect(shortToolPath(resolveCodePath(inProject, ctx), inProject)).toBe('src/app.ts')
  })

  it('shows an extra folder’s file relative to it, and anything else by name', () => {
    const extra = 'D:/docs/specs/a.md'
    expect(
      shortToolPath({ kind: 'unresolved', reason: 'extra-folder' }, extra, ['D:/docs'])
    ).toBe('specs/a.md')
    expect(
      shortToolPath({ kind: 'unresolved', reason: 'outside' }, 'E:\\far\\away\\b.txt')
    ).toBe('b.txt')
  })
})

describe('absoluteChangePath', () => {
  const roots = { treeRoot: 'C:/work/repo', workspacePath: 'C:/data/sessions/s1' }
  it('joins a Git row to the tree and a sandbox row to the sandbox', () => {
    expect(
      absoluteChangePath('src/a.ts', 'git', { ...roots, resolved: { kind: 'project', rel: 'src/a.ts' } })
    ).toBe('C:/work/repo/src/a.ts')
    expect(
      absoluteChangePath('out.md', 'session', { ...roots, resolved: { kind: 'sandbox', rel: 'out.md' } })
    ).toBe('C:/data/sessions/s1/out.md')
    expect(
      absoluteChangePath('C:/x/y.md', 'session', { ...roots, resolved: { kind: 'unresolved', reason: 'outside' } })
    ).toBe('C:/x/y.md')
  })
})
