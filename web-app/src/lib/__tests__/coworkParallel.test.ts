import { describe, expect, it } from 'vitest'
import {
  autoIsolateAction,
  copyAsWorktree,
  isPlaceholderTitle,
  lineDiff,
  sessionCommitMessage,
  type AutoIsolateInput,
} from '@/lib/coworkParallel'

const base: AutoIsolateInput = {
  enabled: true,
  sessionId: 's1',
  folder: '/repo',
  access: 'review-only',
  hasWorktree: false,
  capable: true,
  capabilityKnown: true,
  turns: 0,
  mark: undefined,
  busy: false,
}

describe('autoIsolateAction', () => {
  it('starts a new session on the default access mode in its own worktree', () => {
    expect(autoIsolateAction(base)).toBe('start')
  })

  it('leaves a session alone when the setting is off', () => {
    expect(autoIsolateAction({ ...base, enabled: false })).toBe('none')
  })

  it('never moves a session that already started, or that picked a mode', () => {
    expect(autoIsolateAction({ ...base, turns: 2 })).toBe('none')
    expect(autoIsolateAction({ ...base, access: 'edit-folder' })).toBe('none')
    expect(autoIsolateAction({ ...base, mark: 'skipped' })).toBe('none')
  })

  it('waits for the capability and for a run to finish', () => {
    expect(autoIsolateAction({ ...base, capabilityKnown: false })).toBe('none')
    expect(autoIsolateAction({ ...base, capable: false })).toBe('none')
    expect(autoIsolateAction({ ...base, busy: true })).toBe('none')
  })

  it('re-attaches an isolated session after a restart, even with turns', () => {
    const input = {
      ...base,
      mark: 'worktree' as const,
      access: 'managed-worktree',
      turns: 5,
    }
    expect(autoIsolateAction(input)).toBe('resume')
    expect(autoIsolateAction({ ...input, hasWorktree: true })).toBe('none')
    // Moved back to review-only by the user: stays there.
    expect(autoIsolateAction({ ...input, access: 'review-only' })).toBe('none')
    // Resumed even when the default was turned off later.
    expect(autoIsolateAction({ ...input, enabled: false })).toBe('resume')
  })

  it('gives each of many sessions on one folder its own decision', () => {
    const decisions = ['a', 'b', 'c'].map((id) =>
      autoIsolateAction({ ...base, sessionId: id })
    )
    expect(decisions).toEqual(['start', 'start', 'start'])
  })
})

describe('titles and messages', () => {
  it('treats the starting title as no title', () => {
    expect(isPlaceholderTitle('New session')).toBe(true)
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle('Fix parser')).toBe(false)
    expect(sessionCommitMessage('New session')).toBe('Work from a Flint session')
    expect(sessionCommitMessage(' Fix parser ')).toBe('Fix parser')
  })
})

describe('copies', () => {
  it('describes a copy as a worktree record the Git check skips', () => {
    const record = copyAsWorktree({
      path: '/data/wt/copies/abc',
      sourceRoot: '/proj',
      createdAt: 1,
      fileCount: 3,
    })
    expect(record.kind).toBe('copy')
    expect(record.path).toBe('/data/wt/copies/abc')
    expect(record.sourceRoot).toBe('/proj')
  })

  it('diffs lines for the review', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
    ])
    expect(lineDiff(null, 'x')).toEqual([{ kind: 'add', text: 'x' }])
    expect(lineDiff('x', null)).toEqual([{ kind: 'del', text: 'x' }])
  })
})
