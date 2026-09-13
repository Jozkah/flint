import { describe, it, expect } from 'vitest'
import { rankReferences, type ReferenceSources } from '../referenceMenu'

const sources: ReferenceSources = {
  files: [
    { path: 'src/review.ts', name: 'review.ts', kind: 'file', extension: 'ts' },
    { path: 'docs', name: 'docs', kind: 'directory' },
  ],
  skills: [{ name: 'reviewer', description: 'Reviews a diff' }],
  agents: [{ name: 'review-bot', description: 'Second opinion' }],
  aliases: [{ name: 'rev', target: 'docs/review.md', createdAt: 1 }],
}

describe('rankReferences', () => {
  it('offers every kind in one list, each inserting its identifier', () => {
    const found = rankReferences('rev', sources)
    expect(found.map((e) => [e.kind, e.token])).toEqual([
      ['alias', 'alias:rev'],
      ['skill', 'skill:reviewer'],
      ['agent', 'agent:review-bot'],
      ['file', 'src/review.ts'],
    ])
  })

  it('ranks an exact name above a prefix above a substring', () => {
    const found = rankReferences('reviewer', sources)
    expect(found[0].token).toBe('skill:reviewer')
  })

  it('narrows to one kind when the query names it', () => {
    expect(rankReferences('agent:rev', sources).map((e) => e.token)).toEqual([
      'agent:review-bot',
    ])
  })

  // The index being unavailable must not take the rest of the menu with it.
  it('still offers the others when the file listing is empty', () => {
    const found = rankReferences('rev', { ...sources, files: [] })
    expect(found.map((e) => e.kind)).toEqual(['alias', 'skill', 'agent'])
  })

  it('never offers a name its typed token could not carry', () => {
    const found = rankReferences('', {
      ...sources,
      skills: [{ name: 'has space' }],
    })
    expect(found.some((e) => e.token.includes(' '))).toBe(false)
  })

  it('offers files only as the folder-relative paths it was given', () => {
    const found = rankReferences('', sources)
    for (const entry of found.filter((e) => e.kind === 'file')) {
      expect(entry.token.startsWith('/')).toBe(false)
      expect(/^[a-zA-Z]:/.test(entry.token)).toBe(false)
    }
  })
})
