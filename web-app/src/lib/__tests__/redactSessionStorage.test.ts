/**
 * The Cowork session store is redacted on its way to disk, and only there.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const secretsRedact = vi.fn()
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  secretsRedact: (...a: unknown[]) => secretsRedact(...a),
}))

import {
  redactPersistedSessions,
  redactingSessionStorage,
} from '../redactSessionStorage'
import { UNREDACTABLE } from '../redactToolOutput'

const SECRETS = ['hunter2x', 'abcdefghij', 'tok-1234567890abcd']

beforeEach(() => {
  secretsRedact.mockReset()
  secretsRedact.mockImplementation(async (text: string) => {
    let out = text
    for (const s of SECRETS) out = out.split(s).join('[redacted]')
    return out
  })
})

const blob = () =>
  JSON.stringify({
    state: {
      currentId: 's1',
      sessions: [
        {
          id: 's1',
          title: 'API_KEY= hunter2x in a title is left',
          messages: [
            {
              id: 'm1',
              role: 'user',
              parts: [{ type: 'text', text: 'run the deploy please' }],
            },
            {
              id: 'm2',
              role: 'assistant',
              parts: [
                {
                  type: 'tool-bash',
                  toolCallId: 'c1',
                  state: 'output-available',
                  input: { command: 'curl -H "Authorization: Bearer tok-1234567890abcd"' },
                  output: 'API_KEY= hunter2x\n{"token":"abcdefghij"}',
                },
              ],
            },
          ],
          turns: [
            { role: 'tool', content: '', callId: 'c1', args: { command: 'echo hunter2x' }, result: '{"token":"abcdefghij"}' },
            { role: 'assistant', content: 'prose that mentions PATH=/usr/bin' },
          ],
          inFlight: { turns: [{ role: 'tool', content: '', result: 'tok-1234567890abcd' }] },
        },
      ],
    },
    version: 4,
  })

describe('redactPersistedSessions', () => {
  it('removes secrets from tool parts, tool turns and in-flight turns', async () => {
    const out = await redactPersistedSessions(blob())
    for (const s of SECRETS) {
      // The one survivor is the session title, which is not a tool result.
      expect(out.replace('API_KEY= hunter2x in a title is left', '')).not.toContain(s)
    }
    const doc = JSON.parse(out)
    const session = doc.state.sessions[0]
    expect(session.messages[1].parts[0].output).toContain('[redacted]')
    expect(session.messages[1].parts[0].toolCallId).toBe('c1')
    expect(session.turns[0].callId).toBe('c1')
    expect(session.turns[1].content).toBe('prose that mentions PATH=/usr/bin')
    expect(session.messages[0].parts[0].text).toBe('run the deploy please')
    expect(doc.version).toBe(4)
  })

  it('withholds rather than stores a string it could not check', async () => {
    secretsRedact.mockRejectedValue(new Error('gone'))
    // Text not seen by an earlier test: results are cached per string.
    const fresh = JSON.stringify({
      state: { sessions: [{ id: 's9', turns: [{ role: 'tool', content: '', result: 'password= zq9-never-checked' }] }] },
    })
    const out = await redactPersistedSessions(fresh)
    expect(out).toContain(UNREDACTABLE)
    expect(out).not.toContain('zq9-never-checked')
  })

  it('passes anything that is not a session blob through unchanged', async () => {
    expect(await redactPersistedSessions('not json')).toBe('not json')
    expect(await redactPersistedSessions('{"state":{"x":1}}')).toBe('{"state":{"x":1}}')
  })
})

describe('redactingSessionStorage', () => {
  it('hands the inner storage the redacted value only', async () => {
    const inner = {
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn().mockResolvedValue(undefined),
    }
    await redactingSessionStorage(inner).setItem('cowork', blob())
    const written = inner.setItem.mock.calls[0][1] as string
    expect(written).not.toContain('Bearer tok-1234567890abcd')
    expect(inner.setItem.mock.calls[0][0]).toBe('cowork')
  })
})
