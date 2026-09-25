import { describe, it, expect } from 'vitest'
import { fetchedUrlOf, summarizeWebSources } from '../webSources'
import { siteInitial } from '../webUrl'

describe('summarizeWebSources', () => {
  it('counts pages read apart from search hits', () => {
    const hits = ['a', 'b', 'c', 'd', 'e'].map((x) => ({ url: `https://${x}.com/` }))
    const s = summarizeWebSources(hits, ['https://b.com/', 'https://z.com/', 'https://b.com/'])
    expect(s.read).toBe(2)
    expect(s.found).toBe(4)
    expect(s.sources.map((c) => c.url)).toEqual([
      'https://b.com/',
      'https://z.com/',
      'https://a.com/',
      'https://c.com/',
      'https://d.com/',
      'https://e.com/',
    ])
  })

  it('with nothing read, everything is found', () => {
    const s = summarizeWebSources([{ url: 'https://a.com' }, { url: 'https://a.com' }], [])
    expect(s).toMatchObject({ read: 0, found: 1 })
  })
})

describe('fetchedUrlOf', () => {
  it('reads the URL line of a web_fetch result, raw or wrapped', () => {
    const text = 'Title: X\nURL: https://learn.microsoft.com/a/b?c=1\n\nbody'
    expect(fetchedUrlOf(text)).toBe('https://learn.microsoft.com/a/b?c=1')
    expect(fetchedUrlOf({ content: text })).toBe('https://learn.microsoft.com/a/b?c=1')
    expect(fetchedUrlOf('web_fetch failed: timeout')).toBeNull()
  })
})

describe('siteInitial', () => {
  it('uses the site name, not a common subdomain', () => {
    expect(siteInitial('https://learn.microsoft.com/x')).toBe('M')
    expect(siteInitial('https://developer.mozilla.org/x')).toBe('M')
    expect(siteInitial('https://docs.python.org/3/')).toBe('P')
    expect(siteInitial('https://www.rust-lang.org/')).toBe('R')
    expect(siteInitial('https://docs.rs/serde')).toBe('D')
    expect(siteInitial('https://www.bbc.co.uk/news')).toBe('B')
    expect(siteInitial('https://github.com/a')).toBe('G')
  })

  it('falls back to a question mark when there is no name', () => {
    expect(siteInitial('https://-/')).toBe('?')
  })
})
