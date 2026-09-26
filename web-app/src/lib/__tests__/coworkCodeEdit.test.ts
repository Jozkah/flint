import { describe, expect, it } from 'vitest'
import {
  checkDisk,
  discardBuffer,
  isDirty,
  markSaved,
  planUserWrite,
  userEditNotice,
  withUserEditNotice,
} from '../coworkCodeEdit'
import {
  artifactTab,
  externalTab,
  projectKeyOf,
  projectTab,
  sandboxTab,
} from '../coworkCode'

const ROOT = 'C:\\work\\repo'
const KEY = projectKeyOf(ROOT) as string

const plan = (
  tab: Parameters<typeof planUserWrite>[0]['tab'],
  access: Parameters<typeof planUserWrite>[0]['access']
) =>
  planUserWrite({ tab, projectKey: KEY, treeRoot: ROOT, sessionKey: 's1', access })

describe('where a hand edit is saved', () => {
  it('writes the real file under the grant when the session edits the folder', () => {
    expect(
      plan(projectTab('src/a.ts', KEY), {
        destination: 'repository',
        writeGrant: 'g1',
      })
    ).toEqual({ kind: 'real', path: 'C:\\work\\repo\\src\\a.ts', grant: 'g1' })
  })

  it('writes the worktree the same way in a managed session', () => {
    const tree = '/tmp/wt'
    expect(
      planUserWrite({
        tab: projectTab('a.ts', projectKeyOf(tree) as string),
        projectKey: projectKeyOf(tree),
        treeRoot: tree,
        sessionKey: 's1',
        access: { destination: 'managed', writeGrant: 'g2' },
      })
    ).toEqual({ kind: 'real', path: '/tmp/wt/a.ts', grant: 'g2' })
  })

  it('writes the sandbox copy in Review only', () => {
    expect(
      plan(projectTab('src/a.ts', KEY), { destination: 'sandbox', writeGrant: 'g1' })
    ).toEqual({ kind: 'sandbox', path: 'src/a.ts' })
  })

  it('stays read-only, with a reason, where no write is possible', () => {
    const repo = { destination: 'repository' as const, writeGrant: 'g' }
    expect(plan(externalTab('x.ts', 's1'), repo)).toEqual({
      kind: 'read-only',
      reason: 'external',
    })
    expect(
      plan(projectTab('a.ts', KEY), { destination: 'repository', writeGrant: null })
    ).toEqual({ kind: 'read-only', reason: 'no-grant' })
    expect(plan(projectTab('a.ts', 'other'), repo)).toEqual({
      kind: 'read-only',
      reason: 'detached',
    })
    expect(plan(sandboxTab('a.ts', 's2'), repo)).toEqual({
      kind: 'read-only',
      reason: 'other-session',
    })
    expect(plan(projectTab('a.ts', KEY), null)).toEqual({
      kind: 'read-only',
      reason: 'pending',
    })
  })

  it('always writes a session sandbox or artifact file to the sandbox', () => {
    const repo = { destination: 'repository' as const, writeGrant: 'g' }
    expect(plan(sandboxTab('out.ts', 's1'), repo)).toEqual({
      kind: 'sandbox',
      path: 'out.ts',
    })
    expect(plan(artifactTab('gen.py', 's1'), repo)).toEqual({
      kind: 'sandbox',
      path: 'gen.py',
    })
  })
})

describe('editor buffers', () => {
  it('is dirty only while the text differs from what was read', () => {
    expect(isDirty(undefined)).toBe(false)
    expect(isDirty({ base: 'a', text: 'a' })).toBe(false)
    expect(isDirty({ base: 'a', text: 'b' })).toBe(true)
  })

  it('discards back to the base, and a save makes the text the base', () => {
    const buffers = { t1: { base: 'a', text: 'b' } }
    expect(discardBuffer(buffers, 't1').t1).toEqual({ base: 'a', text: 'a' })
    expect(markSaved(buffers, 't1', 'b').t1).toEqual({ base: 'b', text: 'b' })
  })

  it('tells a quiet refresh from a conflict when the disk moves', () => {
    expect(checkDisk({ base: 'a', text: 'a' }, 'a')).toBe('unchanged')
    expect(checkDisk({ base: 'a', text: 'a' }, 'b')).toBe('refresh')
    expect(checkDisk({ base: 'a', text: 'mine' }, 'b')).toBe('conflict')
  })
})

describe('telling the agent', () => {
  it('names each hand-edited file once, and says which were sandbox copies', () => {
    const notice = userEditNotice([
      { path: 'src/a.ts', where: 'real' },
      { path: 'src/a.ts', where: 'real' },
      { path: 'b.ts', where: 'sandbox' },
    ])
    expect(notice).toContain('the user edited these files by hand')
    expect(notice.match(/src\/a\.ts/g)).toHaveLength(1)
    expect(notice).toContain('- b.ts (the copy in your session workspace)')
  })

  it('leaves a prompt alone when nothing was edited', () => {
    expect(withUserEditNotice('hi', [])).toBe('hi')
    expect(withUserEditNotice('hi', [{ path: 'a', where: 'real' }])).toMatch(
      /^hi\n\nSince your last turn/
    )
  })
})
