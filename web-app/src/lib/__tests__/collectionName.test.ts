import { describe, expect, it } from 'vitest'
import { looksLikeFilesystemPath } from '@/lib/collectionName'

describe('a collection name that reads as a path', () => {
  // The reported case: typed into something labelled "New Project", by someone
  // who reasonably believed it would open that repository.
  it.each([
    'D:\\Code\\obs-forwarder',
    'C:/src/app',
    'd:\\code',
    '\\\\build-server\\share',
    '/Users/joel/code/jan',
    '/etc',
    '~/code/jan',
    '~',
    './src',
    '../sibling',
    '.\\src',
    '..\\sibling',
    'file:///Users/joel/code',
    'src/components',
    'Code\\obs-forwarder',
  ])('is recognised: %s', (name) => {
    expect(looksLikeFilesystemPath(name)).toBe(true)
  })

  it('is recognised despite surrounding whitespace', () => {
    expect(looksLikeFilesystemPath('  D:\\Code\\obs-forwarder  ')).toBe(true)
  })
})

describe('an ordinary collection name', () => {
  it.each([
    'Research',
    'Q3 planning',
    'obs-forwarder',
    'note-py',
    'Jan v0.8',
    // Spaces around the slash read as prose, not a path.
    'Research / notes',
    'Design and / or copy',
    'C: the language',
    'ratio 1/2 scale',
  ])('is left alone: %s', (name) => {
    expect(looksLikeFilesystemPath(name)).toBe(false)
  })

  it('says nothing about an empty field', () => {
    expect(looksLikeFilesystemPath('')).toBe(false)
    expect(looksLikeFilesystemPath('   ')).toBe(false)
  })
})
