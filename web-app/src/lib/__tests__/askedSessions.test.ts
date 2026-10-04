import { describe, it, expect } from 'vitest'
import { askedFromParts } from '../askedSessions'

const part = (over: Record<string, unknown>) => ({
  type: 'tool-send_message',
  toolCallId: 'c1',
  state: 'output-available',
  input: { to: 'Beta', message: 'hi', wait_seconds: 30 },
  ...over,
})

describe('askedFromParts', () => {
  it('ignores other tools', () => {
    expect(askedFromParts([{ type: 'tool-write' }, { type: 'text' }])).toEqual([])
    expect(askedFromParts(undefined)).toEqual([])
  })

  it('shows a call still running as waiting', () => {
    const [a] = askedFromParts([
      part({ state: 'input-available', output: undefined }),
    ])
    expect(a).toMatchObject({ name: 'Beta', status: 'waiting', answer: null })
  })

  it('carries the answer and the target through', () => {
    const output = JSON.stringify({
      message_id: 'm1',
      to: { session_id: 'S2', display_name: 'Beta session' },
      outcome: 'reply',
      reply: { text: 'forty-two' },
    })
    const [a] = askedFromParts([part({ output })])
    expect(a).toEqual({
      key: 'c1',
      name: 'Beta session',
      sessionId: 'S2',
      status: 'answered',
      answer: 'forty-two',
    })
  })

  it('reports a timeout, a fire-and-forget send and a refusal', () => {
    const to = { session_id: 'S2', display_name: 'Beta' }
    const timeout = JSON.stringify({ to, outcome: 'timeout' })
    const sent = JSON.stringify({ to, delivered_to_status: 'idle' })
    const refused =
      'ERROR: ' +
      JSON.stringify({ error: { code: 'self_target', message: 'no' } })
    const out = askedFromParts([
      part({ toolCallId: 'a', output: timeout }),
      part({ toolCallId: 'b', output: sent }),
      part({ toolCallId: 'c', output: refused }),
    ])
    expect(out.map((o) => o.status)).toEqual(['noAnswer', 'sent', 'notSent'])
    expect(out[2].sessionId).toBeNull()
    expect(out[2].name).toBe('Beta')
  })
})
