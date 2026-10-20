import { describe, it, expect } from 'vitest'
import { markLeft, recapDue, recapTranscript } from '../coworkRecap'

describe('cowork recap', () => {
  it('is due only when the session changed after the user left', () => {
    expect(recapDue('a', 100)).toBe(false)
    markLeft('a', 50)
    expect(recapDue('a', 40)).toBe(false)
    expect(recapDue('a', 60)).toBe(true)
    expect(recapDue('a', undefined)).toBe(false)
  })
  it('keeps the tail and skips tool and hidden rows', () => {
    const t = recapTranscript([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'x' },
      { role: 'user', content: 'h', hidden: true },
      { role: 'assistant', content: 'done' },
    ])
    expect(t).toBe('User: hi\nAssistant: done')
    expect(recapTranscript([{ role: 'user', content: 'z'.repeat(9000) }]).length).toBe(4000)
  })
})
