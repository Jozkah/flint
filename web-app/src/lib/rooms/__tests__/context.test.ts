import { describe, it, expect, vi } from 'vitest'
import { buildPrompt, buildSystemPrompt, projectHistory, UNTRUSTED_NOTICE } from '../context'
import { makeRoom } from './helpers'
import { ROOM_SCHEMA_VERSION, type RoomMessage } from '../types'

let n = 0
const m = (over: Partial<RoomMessage>): RoomMessage => ({
  v: ROOM_SCHEMA_VERSION,
  id: `m${n++}`,
  roomId: 'room-1',
  seq: n,
  turnId: null,
  author: { kind: 'participant', participantId: 'p-a', name: 'Alice' },
  to: { kind: 'room' },
  kind: 'speech',
  text: 'hello',
  round: 1,
  createdAt: 1,
  status: 'complete',
  ...over,
})

describe('context projection', () => {
  const room = makeRoom()
  const alice = { kind: 'participant' as const, participant: room.participants[0] }
  const bob = { kind: 'participant' as const, participant: room.participants[1] }

  it('system prompt carries objective, roles, addressing rules and the untrusted notice', () => {
    const s = buildSystemPrompt(room, alice)
    expect(s).toContain('You are Alice (optimist)')
    expect(s).toContain('Objective: Decide on the plan')
    expect(s).toContain('- Bob (skeptic)')
    expect(s).not.toContain('- Alice')
    expect(s).toContain('@moderator')
    expect(s).toContain(UNTRUSTED_NOTICE)
  })

  it('own speech is assistant; others are user with attribution prefixes', () => {
    const messages = [
      m({ author: { kind: 'user' }, kind: 'user', text: 'Start please', to: { kind: 'room' } }),
      m({ text: 'I propose X' }),
      m({ author: { kind: 'participant', participantId: 'p-b', name: 'Bob' }, text: '@Alice why?', to: { kind: 'participant', participantId: 'p-a' } }),
      m({ author: { kind: 'system' }, kind: 'system', text: 'limit note' }),
      m({ text: '', status: 'failed' }),
    ]
    const forAlice = projectHistory(room, messages, alice).map((e) => e.message)
    expect(forAlice).toEqual([
      { role: 'user', content: '[User to room]: Start please' },
      { role: 'assistant', content: 'I propose X' },
      { role: 'user', content: '[Bob (skeptic) to Alice]: @Alice why?' },
    ])
    const forBob = projectHistory(room, messages, bob).map((e) => e.message)
    expect(forBob[1]).toEqual({ role: 'user', content: '[Alice (optimist) to room]: I propose X' })
    expect(forBob[2].role).toBe('assistant')
  })

  it('ends with a turn cue and merges adjacent roles', async () => {
    const built = await buildPrompt({
      room,
      messages: [m({ text: 'mine' })],
      speaker: alice,
      instruction: 'Please be brief.',
      contextWindow: 32000,
      maxOutputTokens: 512,
    })
    expect(built.messages[0].role).toBe('user')
    expect(built.messages[built.messages.length - 1]).toEqual({
      role: 'user',
      content: '[Room to Alice]: It is your turn, Alice.\nPlease be brief.',
    })
    expect(built.trimmed).toBeNull()
  })

  it('replaces overflowing history with a summary, cached per overflow', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => m({ text: `message ${i} ${'lorem ipsum '.repeat(20)}` }))
    const summarize = vi.fn(async () => 'EARLIER-SUMMARY')
    const cache = new Map<string, string>()
    const input = { room, messages, speaker: bob, contextWindow: 2000, maxOutputTokens: 256, summarize, summaryCache: cache }
    const built = await buildPrompt(input)
    expect(built.trimmed?.kind).toBe('summarized')
    expect(built.messages[0].content).toContain('[Summary of the earlier discussion]: EARLIER-SUMMARY')
    expect(built.messages.map((x) => x.content).join('\n')).toContain('message 59')
    expect(built.messages.map((x) => x.content).join('\n')).not.toContain('message 0 ')
    await buildPrompt(input)
    expect(summarize).toHaveBeenCalledTimes(1)
  })

  it('drops oldest messages when summarisation fails', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => m({ text: `message ${i} ${'lorem ipsum '.repeat(20)}` }))
    const built = await buildPrompt({
      room,
      messages,
      speaker: bob,
      contextWindow: 2000,
      maxOutputTokens: 256,
      summarize: async () => {
        throw new Error('no')
      },
    })
    expect(built.trimmed?.kind).toBe('dropped')
    expect(built.trimmed!.count).toBeGreaterThan(0)
    expect(built.messages.map((x) => x.content).join('\n')).not.toContain('Summary')
  })

  it('shrink halves the history budget', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => m({ text: `message ${i} ${'lorem '.repeat(30)}` }))
    const full = await buildPrompt({ room, messages, speaker: bob, contextWindow: 4000, maxOutputTokens: 256 })
    const half = await buildPrompt({ room, messages, speaker: bob, contextWindow: 4000, maxOutputTokens: 256, shrink: true })
    expect(half.promptText.length).toBeLessThan(full.promptText.length)
  })

  it('uses the 8192 fallback when the window is unknown', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => m({ text: `message ${i} ${'lorem '.repeat(30)}` }))
    const built = await buildPrompt({ room, messages, speaker: bob, contextWindow: null, maxOutputTokens: 1024 })
    expect(built.trimmed?.kind).toBe('dropped')
    expect(built.promptText.length / 3.5).toBeLessThan(8192)
  })
})
