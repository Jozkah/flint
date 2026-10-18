import { describe, it, expect } from 'vitest'
import { splitByMatch } from '../highlightMatch'

describe('splitByMatch', () => {
  it('marks every case-insensitive occurrence and keeps the original casing', () => {
    expect(splitByMatch('Key and KEY and key', 'key')).toEqual([
      { text: 'Key', match: true },
      { text: ' and ', match: false },
      { text: 'KEY', match: true },
      { text: ' and ', match: false },
      { text: 'key', match: true },
    ])
  })

  it('treats regex characters as literal text', () => {
    expect(splitByMatch('price $5.00 (approx)', '(approx)')).toEqual([
      { text: 'price $5.00 ', match: false },
      { text: '(approx)', match: true },
    ])
    expect(splitByMatch('a+b', 'a+b')).toEqual([{ text: 'a+b', match: true }])
  })

  it('handles unicode and trims the query', () => {
    expect(splitByMatch('Café über straße', ' ÜBER ')).toEqual([
      { text: 'Café ', match: false },
      { text: 'über', match: true },
      { text: ' straße', match: false },
    ])
  })

  it('returns the whole text when nothing matches or the query is empty', () => {
    expect(splitByMatch('hello', 'zzz')).toEqual([{ text: 'hello', match: false }])
    expect(splitByMatch('hello', '  ')).toEqual([{ text: 'hello', match: false }])
  })
})
