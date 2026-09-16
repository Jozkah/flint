import { describe, it, expect } from 'vitest'
import { CONCLUDE_SIGNAL, stripConclusion } from '../consensus'

describe('stripConclusion', () => {
  it('leaves an ordinary reply untouched', () => {
    expect(stripConclusion('We should ship Takt.')).toEqual({
      concluded: false,
      text: 'We should ship Takt.',
    })
  })

  it('detects the signal and removes its line from the shown text', () => {
    const raw = `We have consensus: Takt.\n${CONCLUDE_SIGNAL}`
    expect(stripConclusion(raw)).toEqual({ concluded: true, text: 'We have consensus: Takt.' })
  })

  it('removes the signal even mid-text and collapses the gap', () => {
    const raw = `Final answer.\n\n${CONCLUDE_SIGNAL}\n\nthanks all`
    const out = stripConclusion(raw)
    expect(out.concluded).toBe(true)
    expect(out.text).not.toContain(CONCLUDE_SIGNAL)
    expect(out.text).toBe('Final answer.\n\nthanks all')
  })
})
