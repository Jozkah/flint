import { describe, expect, it } from 'vitest'
import { addRoot, checkRoot, removeRoot } from '@/lib/claudeSkillRoots'

const HOME = '/home/dev'
const SKILLS = `${HOME}/.claude/skills`
const JAN_DATA = `${HOME}/.jan`

const ok = { exists: true }

describe('which folders may be read for skills', () => {
  it('accepts an ordinary folder the user picked', () => {
    expect(checkRoot(SKILLS, { approved: [], ...ok })).toEqual({
      ok: true,
      path: SKILLS,
    })
  })

  // A drive is not a skill folder, and scanning one would be a crawl of
  // everything the user owns.
  it.each(['/', 'C:', 'c:/', ''])('refuses %s as too broad', (path) => {
    expect(checkRoot(path, { approved: [], ...ok })).toEqual({
      ok: false,
      reason: 'too-broad',
    })
  })

  it('refuses Jan’s own storage', () => {
    expect(
      checkRoot(`${JAN_DATA}/threads`, {
        approved: [],
        janData: JAN_DATA,
        ...ok,
      })
    ).toEqual({ ok: false, reason: 'jan-data' })
  })

  // The picker can return a path that has since been removed or unmounted.
  it('refuses a folder that is not there', () => {
    expect(checkRoot(SKILLS, { approved: [], exists: false })).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  it('refuses one already covered by an approved folder', () => {
    expect(
      checkRoot(`${SKILLS}/reviewer`, { approved: [SKILLS], ...ok })
    ).toEqual({ ok: false, reason: 'duplicate' })
  })

  // Approving a parent would swallow the narrower choice already made.
  it('refuses a folder that would swallow an approved one', () => {
    expect(checkRoot(HOME, { approved: [SKILLS], ...ok })).toEqual({
      ok: false,
      reason: 'overlaps',
    })
  })

  /**
   * The prefix sibling, again. `skills-backup` starts with `skills`, and a
   * containment check written with string prefixes calls it a duplicate.
   */
  it('treats a folder whose name merely starts the same way as its own', () => {
    expect(
      checkRoot(`${HOME}/.claude/skills-backup`, { approved: [SKILLS], ...ok })
    ).toMatchObject({ ok: true })
  })

  it('normalizes separators and trailing slashes before comparing', () => {
    expect(checkRoot(`${SKILLS}/`, { approved: [SKILLS], ...ok })).toMatchObject(
      { ok: false, reason: 'duplicate' }
    )
  })
})

describe('keeping the list', () => {
  it('adds an accepted folder and leaves the input alone', () => {
    const before: readonly string[] = []
    const { roots, rejected } = addRoot(before, SKILLS, ok)

    expect(roots).toEqual([SKILLS])
    expect(rejected).toBeUndefined()
    expect(before).toEqual([])
  })

  it('reports why a folder was not added, and adds nothing', () => {
    const { roots, rejected } = addRoot([SKILLS], `${SKILLS}/reviewer`, ok)

    expect(rejected).toBe('duplicate')
    expect(roots).toEqual([SKILLS])
  })

  it('removes a folder', () => {
    expect(removeRoot([SKILLS, `${HOME}/other`], SKILLS)).toEqual([
      `${HOME}/other`,
    ])
  })

  it('is unchanged by removing something that is not there', () => {
    expect(removeRoot([SKILLS], `${HOME}/nope`)).toEqual([SKILLS])
  })
})
