import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LanguageModel } from 'ai'

const { buildRoomTools } = vi.hoisted(() => ({ buildRoomTools: vi.fn() }))
vi.mock('../roomTools', async (orig) => ({
  ...(await orig<typeof import('../roomTools')>()),
  buildRoomTools,
}))

import { streamParticipantReply } from '../participantModel'
import { makeProvider, providerLookup } from './helpers'
import type { StreamReplyInput } from '../callError'
import type { RoomDelegation } from '../fullTools'

const lookup = providerLookup([makeProvider('provider-a', ['model-1'])])

const stream = (usage = { inputTokens: 100, outputTokens: 20 }) =>
  vi.fn(() => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', id: 't', text: 'done' }
    })(),
    totalUsage: Promise.resolve(usage),
    finishReason: Promise.resolve('stop'),
  }))

const input = (): StreamReplyInput => ({
  model: { provider: 'provider-a', id: 'model-1' },
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 50,
  signal: new AbortController().signal,
  onText: () => {},
  toolContext: { roomId: 'r', folder: '/w', extraFolders: [], access: 'full', tokenBudget: 5000 },
})

beforeEach(() => {
  buildRoomTools.mockReset()
})

describe('a participant that delegates', () => {
  it('hands the tool builder the model it speaks with, and the room can be charged for children', async () => {
    let delegation: RoomDelegation | undefined
    buildRoomTools.mockImplementation(async (_ctx, _activity, d: RoomDelegation) => {
      delegation = d
      return {}
    })
    const model = {} as LanguageModel
    const res = await streamParticipantReply(input(), {
      lookup,
      createModel: async () => model,
      streamText: stream() as never,
    })
    expect(delegation?.model()).toBe(model)
    expect(delegation?.modelId).toBe('model-1')
    // Nothing delegated: the turn's own usage, untouched.
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  it('adds what its subagents used to the turn, so the room limit sees it', async () => {
    buildRoomTools.mockImplementation(async (_ctx, _activity, d: RoomDelegation) => {
      // Two children finish during the turn.
      d.onUsage({ prompt_tokens: 400, completion_tokens: 60 })
      d.onUsage({ total_tokens: 90 })
      d.onUsage(null)
      return {}
    })
    const res = await streamParticipantReply(input(), {
      lookup,
      createModel: async () => ({}) as LanguageModel,
      streamText: stream() as never,
    })
    expect(res.usage).toEqual({ inputTokens: 100 + 400, outputTokens: 20 + 60 + 90 })
  })
})
