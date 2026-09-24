import { describe, it, expect } from 'vitest'
import {
  composeWindowTitle,
  lastPathSegment,
  sanitizeTitleSegment,
  sessionDetailsLabel,
} from '@/lib/windowTitle'

describe('composeWindowTitle', () => {
  it('names the open chat', () => {
    expect(
      composeWindowTitle({ section: 'chat', threadTitle: 'Fix the login bug' })
    ).toBe('Fix the login bug - Flint')
  })

  it('falls back to the app name for an untitled chat', () => {
    expect(composeWindowTitle({ section: 'chat', threadTitle: '' })).toBe('Flint')
    expect(composeWindowTitle({ section: 'chat' })).toBe('Flint')
  })

  it('names a Cowork session by its title and project folder name only', () => {
    const title = composeWindowTitle({
      section: 'cowork',
      sessionTitle: 'Refactor parser',
      projectFolder: 'C:\\Users\\alice\\secret-client\\acme-api',
    })
    expect(title).toBe('Refactor parser · acme-api - Flint Cowork')
    expect(title).not.toContain('alice')
    expect(title).not.toContain('secret-client')
  })

  it('names a Cowork session with no project', () => {
    expect(
      composeWindowTitle({ section: 'cowork', sessionTitle: 'Plan', projectFolder: null })
    ).toBe('Plan - Flint Cowork')
    expect(composeWindowTitle({ section: 'cowork' })).toBe('Flint Cowork')
  })

  it('names settings and anything else plainly', () => {
    expect(composeWindowTitle({ section: 'settings' })).toBe('Settings - Flint')
    expect(composeWindowTitle({ section: 'other' })).toBe('Flint')
  })
})

describe('sanitizeTitleSegment', () => {
  it('cuts paths inside a generated title to their last segment', () => {
    expect(
      sanitizeTitleSegment('Why does C:\\Users\\bob\\proj\\main.rs panic')
    ).toBe('Why does main.rs panic')
    expect(sanitizeTitleSegment('Read /home/bob/.ssh/config please')).toBe(
      'Read config please'
    )
    expect(sanitizeTitleSegment('Open ~/work/client/notes.md')).toBe(
      'Open notes.md'
    )
    expect(sanitizeTitleSegment('Copy \\\\server\\share\\x.txt')).toBe(
      'Copy x.txt'
    )
  })

  it('leaves ordinary slashes between words alone', () => {
    expect(sanitizeTitleSegment('Pros and/or cons')).toBe('Pros and/or cons')
  })

  it('removes control characters and collapses whitespace', () => {
    expect(sanitizeTitleSegment('a\u0000b\n\tc   d')).toBe('a b c d')
  })

  it('bounds the length', () => {
    const long = 'x'.repeat(200)
    const out = sanitizeTitleSegment(long)
    expect(Array.from(out).length).toBe(60)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('lastPathSegment', () => {
  it('handles both separators and trailing slashes', () => {
    expect(lastPathSegment('C:\\a\\b\\')).toBe('b')
    expect(lastPathSegment('/a/b/c')).toBe('c')
    expect(lastPathSegment('')).toBe('')
  })
})

describe('sessionDetailsLabel (#94)', () => {
  it('shortens a Windows folder to its last segment', () => {
    expect(sessionDetailsLabel('C:\\Users\\foo\\repo', 'main')).toBe('repo · main')
    expect(sessionDetailsLabel('C:\\Users\\foo\\repo\\', null)).toBe('repo')
  })

  it('shortens a POSIX folder and handles no folder', () => {
    expect(sessionDetailsLabel('/home/u/repo', 'dev')).toBe('repo · dev')
    expect(sessionDetailsLabel(undefined, 'dev')).toBe('')
  })
})
