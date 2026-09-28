import { describe, it, expect, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { RoomCallError, streamParticipantReply } from '../participantModel'
import { makeProvider, providerLookup } from './helpers'
import type { StreamReplyInput } from '../callError'

const lookup = providerLookup([makeProvider('provider-a', ['model-1'])])

function fakeStream(parts: unknown[], usage: unknown = { inputTokens: 3, outputTokens: 2 }) {
  return vi.fn((_args: Record<string, unknown>) => ({
    fullStream: (async function* () {
      for (const p of parts) yield p
    })(),
    totalUsage: Promise.resolve(usage),
    finishReason: Promise.resolve('stop'),
  }))
}

const input = (over: Partial<StreamReplyInput> = {}): StreamReplyInput => ({
  model: { provider: 'provider-a', id: 'model-1' },
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 77,
  signal: new AbortController().signal,
  onText: () => {},
  ...over,
})

describe('streamParticipantReply', () => {
  it('streams only text deltas, never reasoning, and returns usage', async () => {
    const stream = fakeStream([
      { type: 'reasoning-delta', id: 'r', text: 'SECRET THOUGHTS' },
      { type: 'text-delta', id: 't', text: 'Hel' },
      { type: 'text-delta', id: 't', text: 'lo' },
    ])
    const deltas: string[] = []
    const createModel = vi.fn(async () => ({}) as LanguageModel)
    const res = await streamParticipantReply(input({ onText: (d) => deltas.push(d) }), {
      lookup,
      createModel,
      streamText: stream as never,
    })
    expect(res).toEqual({ text: 'Hello', usage: { inputTokens: 3, outputTokens: 2 }, finishReason: 'stop' })
    expect(deltas).toEqual(['Hel', 'lo'])
    const args = stream.mock.calls[0][0]
    expect(args).not.toHaveProperty('tools')
    expect(args.maxOutputTokens).toBe(77)
    expect(args.system).toBe('SYS')
    expect(createModel).toHaveBeenCalledWith('model-1', expect.objectContaining({ provider: 'provider-a' }), {})
  })

  it("applies the participant's reasoning: body fields to the model, native options to the stream", async () => {
    const local = providerLookup([
      makeProvider('llamacpp', [{ id: 'qwen', settings: { ctx_len: { controller_props: { value: 40960 } } } as never }]),
      makeProvider('openai', ['gpt-5']),
    ])
    const createModel = vi.fn(async () => ({}) as LanguageModel)
    const stream = fakeStream([{ type: 'text-delta', id: 't', text: 'ok' }])
    await streamParticipantReply(
      input({
        model: { provider: 'llamacpp', id: 'qwen' },
        reasoning: { mode: 'on', level: 'low' },
        maxOutputTokens: 8192,
      }),
      { lookup: local, createModel, streamText: stream as never }
    )
    // Low = 10% of the 40960-token context.
    expect(createModel).toHaveBeenCalledWith('qwen', expect.anything(), {
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: 4096,
    })
    expect(stream.mock.calls[0][0]).not.toHaveProperty('providerOptions')

    const createCloud = vi.fn(async () => ({}) as LanguageModel)
    const cloudStream = fakeStream([{ type: 'text-delta', id: 't', text: 'ok' }])
    await streamParticipantReply(
      input({ model: { provider: 'openai', id: 'gpt-5' }, reasoning: { level: 'high' } }),
      { lookup: local, createModel: createCloud, streamText: cloudStream as never }
    )
    expect(createCloud).toHaveBeenCalledWith('gpt-5', expect.anything(), {})
    expect(cloudStream.mock.calls[0][0].providerOptions).toEqual({
      openai: { reasoningEffort: 'high', reasoningSummary: 'auto' },
    })
  })

  it('reports a missing provider as unavailable', async () => {
    await expect(
      streamParticipantReply(input({ model: { provider: 'gone', id: 'x' } }), { lookup })
    ).rejects.toMatchObject({ kind: 'unavailable', code: 'provider-missing' })
  })

  it('classifies model creation failure as load-failed', async () => {
    const err = await streamParticipantReply(input(), {
      lookup,
      createModel: async () => {
        throw new Error('llama-server exited')
      },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RoomCallError)
    expect(err).toMatchObject({ kind: 'load-failed', message: 'llama-server exited' })
  })

  it('races model load against abort', async () => {
    const ac = new AbortController()
    const p = streamParticipantReply(input({ signal: ac.signal }), {
      lookup,
      createModel: () => new Promise<LanguageModel>(() => {}),
    })
    ac.abort()
    await expect(p).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('classifies stream errors: transient status and context overflow', async () => {
    const createModel = async () => ({}) as LanguageModel
    const server = Object.assign(new Error('Service unavailable'), { statusCode: 503 })
    await expect(
      streamParticipantReply(input(), { lookup, createModel, streamText: fakeStream([{ type: 'error', error: server }]) as never })
    ).rejects.toMatchObject({ kind: 'provider', code: 'transient:503' })
    const overflow = Object.assign(new Error("This model's maximum context length is 4096 tokens"), { statusCode: 400 })
    await expect(
      streamParticipantReply(input(), { lookup, createModel, streamText: fakeStream([{ type: 'error', error: overflow }]) as never })
    ).rejects.toMatchObject({ kind: 'overflow' })
  })
})
