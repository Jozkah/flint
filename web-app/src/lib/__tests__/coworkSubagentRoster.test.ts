import { describe, it, expect } from 'vitest'
import { errandLine, joinRoster, rosterBlock } from '../coworkSubagentRoster'

describe('roster', () => {
  it('a lone child gets no block', () => {
    const a = joinRoster('r1', 'c1', { name: 'a', errand: 'x' })
    expect(rosterBlock(a.siblings)).toBeUndefined()
    a.leave()
  })
  it('a later child sees earlier ones, not itself, and leaving removes it', () => {
    const a = joinRoster('r2', 'c1', { name: 'reader', errand: 'survey api' })
    const b = joinRoster('r2', 'c2', { name: 'tester', errand: 'run tests' })
    expect(b.siblings).toEqual([{ name: 'reader', errand: 'survey api' }])
    expect(rosterBlock(b.siblings)).toContain('- reader: survey api')
    a.leave()
    expect(joinRoster('r2', 'c3', { name: 'c', errand: 'z' }).siblings).toEqual([{ name: 'tester', errand: 'run tests' }])
    b.leave()
  })
  it('other runs are separate; long lists are counted', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, errand: 'e' }))
    expect(rosterBlock(many)).toContain('and 2 more')
    const x = joinRoster('r3', 'c1', { name: 'a', errand: 'e' })
    expect(joinRoster('r4', 'c1', { name: 'b', errand: 'e' }).siblings).toEqual([])
    x.leave()
  })
  it('errandLine prefers the title and bounds the brief', () => {
    expect(errandLine('Find routes', 'long brief')).toBe('Find routes')
    expect(errandLine(undefined, '\n  first   line\nsecond')).toBe('first line')
    expect(errandLine(undefined, 'x'.repeat(500)).length).toBe(120)
  })
})
