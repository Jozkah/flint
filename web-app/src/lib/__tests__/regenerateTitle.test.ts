import { describe, expect, it } from 'vitest'
import type { ThreadMessage } from '@janhq/core'
import { titleTranscript } from '../regenerateTitle'

const msg = (role: string, text: string): ThreadMessage =>
  ({
    id: text,
    role,
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
  }) as unknown as ThreadMessage

describe('titleTranscript', () => {
  it('labels each turn and keeps a short chat whole', () => {
    expect(titleTranscript([msg('user', 'hi'), msg('assistant', 'hello')])).toBe(
      'User: hi\n\nAssistant: hello'
    )
  })

  it('keeps the opening and the latest turns of a long chat', () => {
    const turns = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`)
    )
    const out = titleTranscript(turns)
    expect(out).toContain('turn 0')
    expect(out).toContain('turn 2')
    expect(out).toContain('turn 29')
    expect(out).not.toContain('turn 10')
    expect(out.split('\n\n')).toHaveLength(9)
  })

  it('trims a long turn and skips empty ones', () => {
    const out = titleTranscript([msg('user', 'x'.repeat(1000)), msg('assistant', '  ')])
    expect(out.length).toBeLessThan(450)
    expect(out.endsWith('...')).toBe(true)
  })

  it('is empty when there is nothing to read', () => {
    expect(titleTranscript([])).toBe('')
  })
})
