import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from 'ai'

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      getProviderByName: () => ({ base_url: 'http://127.0.0.1:8000/v1' }),
    }),
  },
}))
vi.mock('@/lib/toolActivity', () => ({ recordLifecycle: vi.fn() }))

import { createCompactRun } from '../compactRun'
import { isUnfittableRequest } from '../unfittable'
import { DEFAULT_COMPACTION_POLICY } from '@/lib/compactionPolicy'
import { forgetAllServerLimits, serverReportedLimit } from '@/lib/contextLimitRecovery'

// vLLM's standard refusal for a 205.6K prompt against a 200K server.
const REFUSAL_BODY = {
  object: 'error',
  message:
    "This model's maximum context length is 200000 tokens. However, you requested 205640 tokens (205128 in the messages, 512 in the completion). Please reduce the length of the messages or completion.",
  type: 'BadRequestError',
  param: null,
  code: 400,
}
const refusal = Object.assign(new Error(REFUSAL_BODY.message), { data: REFUSAL_BODY })

const known = (tokens: number) => ({ known: 'estimated' as const, tokens })
const msgs: UIMessage[] = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `turn ${i}` }],
})) as UIMessage[]

function setup(tools: number, conversation: number) {
  let learned: number | null = null
  const summarize = vi.fn(async () => 'summary')
  const run = createCompactRun({
    sid: 's',
    runId: 'r',
    autoCompact: true,
    // The provider listed 262,144; the server runs at 200,000.
    runWindow: 262144,
    compactionPolicy: DEFAULT_COMPACTION_POLICY,
    selectedProvider: 'vllm',
    selectedModelId: 'qwen3',
    transport: {
      measureContext: () =>
        ({
          categories: {
            instructions: known(4000),
            skills: known(0),
            repositoryMap: known(0),
            conversation: known(conversation),
            tools: known(tools),
          },
          budget: known(200000),
        }) as never,
      advertisedTools: Object.fromEntries(
        Array.from({ length: 502 }, (_, i) => [`t${i}`, {}])
      ) as never,
    },
    summarize,
    getLearnedWindow: () => learned,
    setLearnedWindow: (t) => {
      learned = t
    },
    setCompacting: () => {},
    pushLive: () => {},
  })
  return { run, summarize, learnedWindow: () => learned }
}

describe('a context-length refusal in a Cowork run', () => {
  beforeEach(() => forgetAllServerLimits())

  it('learns the smaller window the server named, per endpoint', async () => {
    const { run, learnedWindow } = setup(10000, 3000)
    await run(msgs, 'context-error', new AbortController().signal, refusal).catch(() => null)
    expect(learnedWindow()).toBe(200000)
    expect(
      serverReportedLimit({
        provider: 'vllm',
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'qwen3',
      })?.contextTokens
    ).toBe(200000)
    expect(
      serverReportedLimit({ provider: 'other', baseUrl: 'http://x/v1', model: 'qwen3' })
    ).toBeNull()
  })

  it('stops with the tool breakdown instead of summarizing when tools fill the window', async () => {
    const { run, summarize } = setup(189000, 12000)
    const error = await run(msgs, 'context-error', new AbortController().signal, refusal).then(
      () => null,
      (e) => e
    )
    expect(isUnfittableRequest(error)).toBe(true)
    expect(error.message).toMatch(/Most of it is the tool definitions \(502 tools\)/)
    expect(error.message).toMatch(/turn off MCP servers or tools/)
    expect(summarize).not.toHaveBeenCalled()
  })
})
