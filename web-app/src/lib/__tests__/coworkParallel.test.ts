import { describe, expect, it, vi } from 'vitest'
import {
  isGitRepo,
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

  it('re-attaches a manually selected managed worktree after a restart', () => {
    const input = {
      ...base,
      enabled: false,
      access: 'managed-worktree',
      turns: 5,
    }
    expect(autoIsolateAction(input)).toBe('resume')
    expect(autoIsolateAction({ ...input, hasWorktree: true })).toBe('none')
    expect(autoIsolateAction({ ...input, busy: true })).toBe('none')
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

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('isGitRepo', () => {
  it('passes true and false through', async () => {
    invoke.mockResolvedValueOnce(true)
    expect(await isGitRepo('/a')).toBe(true)
    invoke.mockResolvedValueOnce(false)
    expect(await isGitRepo('/a')).toBe(false)
  })

  it('returns null, not false, when the check fails', async () => {
    invoke.mockRejectedValueOnce(new Error('busy'))
    expect(await isGitRepo('/a')).toBeNull()
  })
})

describe('lineDiff parity with the plain LCS diff', () => {
  // The original full-table implementation, kept as the reference.
  const reference = (a: string | null, b: string | null) => {
    const x = a === null ? [] : a.split(/\r?\n/)
    const y = b === null ? [] : b.split(/\r?\n/)
    const n = x.length
    const m = y.length
    const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
    const out: { kind: string; text: string }[] = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push({ kind: 'same', text: x[i] })
        i++
        j++
      } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: 'del', text: x[i++] })
      else out.push({ kind: 'add', text: y[j++] })
    }
    while (i < n) out.push({ kind: 'del', text: x[i++] })
    while (j < m) out.push({ kind: 'add', text: y[j++] })
    return out
  }

  it('is a valid diff with as many shared lines as the reference on many small random pairs', () => {
    let seed = 12345
    const rand = (k: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % k
    }
    const make = () =>
      Array.from({ length: rand(10) }, () => 'abc'[rand(3)]).join('\n')
    for (let k = 0; k < 400; k++) {
      const a = make()
      const b = make()
      const got = lineDiff(a, b)
      const ref = reference(a, b)
      // Equally long common subsequences can pair the lines up differently, so
      // compare what a diff must guarantee rather than the exact alignment.
      const side = (kinds: string[]) => got.filter((l) => kinds.includes(l.kind)).map((l) => l.text)
      expect(side(['same', 'del']), JSON.stringify([a, b])).toEqual(a.split(/\r?\n/))
      expect(side(['same', 'add'])).toEqual(b.split(/\r?\n/))
      expect(got.filter((l) => l.kind === 'same').length).toBe(ref.filter((l) => l.kind === 'same').length)
    }
  })

  it('still shows a real diff for a long file with one changed line', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const edited = [...lines]
    edited[1500] = 'changed'
    const diff = lineDiff(lines.join('\n'), edited.join('\n'))
    expect(diff.filter((d) => d.kind !== 'same')).toEqual([
      { kind: 'del', text: 'line 1500' },
      { kind: 'add', text: 'changed' },
    ])
    expect(diff).toHaveLength(3001)
  })
})
