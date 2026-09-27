import { describe, expect, it, vi } from 'vitest'
import {
  describeProbeError,
  modelFingerprint,
  PROBE_TOOL,
  probeTools,
  runModelProbe,
  validateProbeArgs,
  type ProbeDeps,
} from '@/lib/modelDoctor'
import { currentDoctorResult, doctorKey, observedToolsFact } from '@/hooks/useModelDoctor'

const provider = (over: Partial<ProviderObject> = {}): ProviderObject => ({
  active: true,
  provider: 'llamacpp',
  base_url: 'http://127.0.0.1:0',
  api_key: 'sk-secret-should-never-matter-000000',
  settings: [
    {
      key: 'api-key',
      title: 'API key',
      description: '',
      controller_type: 'input',
      controller_props: { value: 'sk-secret-should-never-matter-000000', type: 'password' },
    },
  ],
  models: [],
  ...over,
})
const model = (over: Partial<Model> = {}): Model => ({
  id: 'qwen3-8b',
  capabilities: ['tools'],
  settings: {
    ctx_len: {
      key: 'ctx_len',
      title: 'Context',
      description: '',
      controller_type: 'input',
      controller_props: { value: 8192 },
    },
  },
  ...over,
})
const identity = {
  provider: 'llamacpp',
  modelId: 'qwen3-8b',
  fingerprint: 'fp',
  settingsSummary: 'llamacpp/qwen3-8b',
}

type Reply = Awaited<ReturnType<NonNullable<ProbeDeps['generate']>>>
const reply = (over: Partial<Reply>): Reply => ({
  text: '',
  finishReason: 'stop',
  toolCalls: [],
  ...over,
})
const goodCall = reply({
  finishReason: 'tool-calls',
  toolCalls: [{ toolCallId: 'c1', toolName: PROBE_TOOL, input: { city: 'Oslo', unit: 'celsius' } }],
})

function deps(replies: Array<Reply | Error | 'hang'>, over: Partial<ProbeDeps> = {}) {
  const calls: Array<Record<string, unknown>> = []
  let i = 0
  const generate = vi.fn(async (args: Record<string, unknown>) => {
    calls.push(args)
    const next = replies[i++]
    if (next === 'hang') {
      return new Promise<Reply>((_, reject) => {
        const signal = args.abortSignal as AbortSignal
        if (signal.aborted) return reject(signal.reason ?? new Error('aborted'))
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      })
    }
    if (next instanceof Error) throw next
    return next
  })
  let t = 1_000
  return {
    calls,
    generate,
    d: {
      createModel: async () => ({}) as never,
      generate: generate as unknown as ProbeDeps['generate'],
      now: () => (t += 10),
      nonce: () => 'K7Q2ZP',
      ...over,
    } satisfies ProbeDeps,
  }
}

describe('runModelProbe', () => {
  it('passes only when the call, its arguments and the continuation all work', async () => {
    const { d, calls } = deps([goodCall, reply({ text: 'The verification code is K7Q2ZP.' })])
    const r = await runModelProbe(identity, d)
    expect(r.outcome).toBe('passed')
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([
      ['tool_call', true],
      ['arguments', true],
      ['continuation', true],
      ['timeout', true],
    ])
    // Two turns; the second continues from a tool result the probe wrote.
    expect(calls).toHaveLength(2)
    const second = calls[1].messages as Array<{ role: string; content: unknown }>
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(JSON.stringify(second[2].content)).toContain('K7Q2ZP')
    expect(r.testedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(r.fingerprint).toBe('fp')
  })

  it('uses only the synthetic tool, which has nothing to execute', async () => {
    const { d, calls } = deps([goodCall, reply({ text: 'K7Q2ZP' })])
    await runModelProbe(identity, d)
    for (const call of calls) {
      const tools = call.tools as Record<string, { execute?: unknown }>
      expect(Object.keys(tools)).toEqual([PROBE_TOOL])
      expect(tools[PROBE_TOOL].execute).toBeUndefined()
      expect(call.toolChoice).toBe('auto')
    }
    expect(Object.keys(probeTools())).toEqual([PROBE_TOOL])
  })

  it('reports prose instead of a tool call', async () => {
    const { d } = deps([reply({ text: 'It is probably 7 degrees in Oslo.' })])
    const r = await runModelProbe(identity, d)
    expect(r.outcome).toBe('failed')
    expect(r.checks[0]).toMatchObject({ id: 'tool_call', ok: false })
    expect(r.checks[0].detail).toContain('answered without calling the tool')
    expect(r.checks[2]).toMatchObject({ id: 'continuation', ok: null })
  })

  it('reports invalid arguments with the reason', async () => {
    const { d } = deps([
      reply({
        finishReason: 'tool-calls',
        toolCalls: [{ toolCallId: 'c1', toolName: PROBE_TOOL, input: { city: 'Oslo', unit: 'kelvin' } }],
      }),
    ])
    const r = await runModelProbe(identity, d)
    expect(r.checks[1]).toMatchObject({ id: 'arguments', ok: false })
    expect(r.checks[1].detail).toContain('kelvin')
  })

  it('fails a model that asks for another city or unit than it was asked', async () => {
    for (const input of [
      { city: 'Paris', unit: 'fahrenheit' },
      { city: 'Paris', unit: 'celsius' },
      { city: 'Oslo', unit: 'fahrenheit' },
    ]) {
      const { d, calls } = deps([
        reply({ finishReason: 'tool-calls', toolCalls: [{ toolCallId: 'c1', toolName: PROBE_TOOL, input }] }),
        reply({ text: 'K7Q2ZP' }),
      ])
      const r = await runModelProbe(identity, d)
      expect(r.outcome).toBe('failed')
      expect(r.checks[1]).toMatchObject({ id: 'arguments', ok: false })
      expect(r.checks[1].detail).toContain('asked for')
      // No Oslo result is ever handed to a model that asked for something else.
      expect(calls).toHaveLength(1)
    }
  })

  it('reports arguments that were not JSON at all', async () => {
    const { d } = deps([
      reply({
        finishReason: 'tool-calls',
        toolCalls: [
          { toolCallId: 'c1', toolName: PROBE_TOOL, input: '{city: Oslo', invalid: true, error: new Error('JSON parse error') },
        ],
      }),
    ])
    const r = await runModelProbe(identity, d)
    expect(r.checks[1].detail).toContain('could not be parsed')
  })

  it('reports a model that calls the tool again instead of continuing', async () => {
    const { d } = deps([goodCall, goodCall])
    const r = await runModelProbe(identity, d)
    expect(r.checks[2]).toMatchObject({ id: 'continuation', ok: false })
    expect(r.checks[2].detail).toContain('called the tool again')
  })

  it('reports a timeout on the step that hung, and stops', async () => {
    const { d } = deps([goodCall, 'hang'], { stepTimeoutMs: 20 })
    const r = await runModelProbe(identity, d)
    expect(r.outcome).toBe('failed')
    expect(r.checks[3]).toMatchObject({ id: 'timeout', ok: false })
    expect(r.checks[3].detail).toContain('continuation turn')
  })

  it('is cancelled cleanly, recording nothing observed', async () => {
    const ctrl = new AbortController()
    const { d } = deps(['hang'])
    const pending = runModelProbe(identity, d, ctrl.signal)
    ctrl.abort()
    const r = await pending
    expect(r.outcome).toBe('cancelled')
  })

  it('is cancelled mid-request, and the request sees the abort', async () => {
    const ctrl = new AbortController()
    const { d, calls } = deps(['hang'])
    const pending = runModelProbe(identity, d, ctrl.signal)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    ctrl.abort()
    const r = await pending
    expect(r.outcome).toBe('cancelled')
    expect((calls[0].abortSignal as AbortSignal).aborted).toBe(true)
  })

  it('reports a transport error without leaking a key', async () => {
    const err = Object.assign(new Error('Unauthorized: Bearer sk-abcdefghijklmnopqrstuv'), {
      statusCode: 401,
    })
    const { d } = deps([err])
    const r = await runModelProbe(identity, d)
    expect(r.checks[0].detail).toContain('HTTP 401')
    expect(r.checks[0].detail).not.toContain('sk-abcdefghijklmnopqrstuv')
  })

  it('can be cancelled while the model is still loading, and gives the load up', async () => {
    const ctrl = new AbortController()
    const abandonLoad = vi.fn()
    const { d, generate } = deps([], {
      createModel: () => new Promise(() => {}),
      abandonLoad,
    })
    const pending = runModelProbe(identity, d, ctrl.signal)
    await new Promise((r) => setTimeout(r, 10))
    ctrl.abort()
    const r = await pending
    expect(r.outcome).toBe('cancelled')
    expect(abandonLoad).toHaveBeenCalledTimes(1)
    expect(generate).not.toHaveBeenCalled()
  })

  it('reports a load that never finishes as a timeout', async () => {
    const abandonLoad = vi.fn()
    const { d, generate } = deps([], {
      createModel: () => new Promise(() => {}),
      loadTimeoutMs: 20,
      abandonLoad,
    })
    const r = await runModelProbe(identity, d)
    expect(r.outcome).toBe('failed')
    expect(r.checks.find((c) => c.id === 'timeout')).toMatchObject({ ok: false })
    expect(r.checks.find((c) => c.id === 'timeout')!.detail).toContain('did not finish loading')
    expect(abandonLoad).toHaveBeenCalledTimes(1)
    expect(generate).not.toHaveBeenCalled()
  })

  it('reports a model that could not be started', async () => {
    const { d } = deps([], { createModel: async () => Promise.reject(new Error('out of memory')) })
    const r = await runModelProbe(identity, d)
    expect(r.checks[0].detail).toContain('could not be started: out of memory')
  })
})

describe('fingerprint and invalidation', () => {
  it('changes with any setting that shapes the request, never with the key', () => {
    const base = modelFingerprint(provider(), model())
    expect(modelFingerprint(provider({ api_key: 'sk-other-000000000000' }), model())).toBe(base)
    expect(
      modelFingerprint(
        provider({
          settings: [
            {
              key: 'api-key',
              title: '',
              description: '',
              controller_type: 'input',
              controller_props: { value: 'sk-rotated', type: 'password' },
            },
          ],
        }),
        model()
      )
    ).toBe(base)
    expect(modelFingerprint(provider({ base_url: 'http://127.0.0.1:1' }), model())).not.toBe(base)
    expect(
      modelFingerprint(
        provider(),
        model({
          settings: {
            ctx_len: {
              key: 'ctx_len',
              title: '',
              description: '',
              controller_type: 'input',
              controller_props: { value: 4096 },
            },
          },
        })
      )
    ).not.toBe(base)
    expect(modelFingerprint(provider(), model({ id: 'other' }))).not.toBe(base)
  })

  it('reports a result from other settings as stale, not as the model status', () => {
    const p = provider()
    const m = model()
    const result = {
      version: 1,
      provider: 'llamacpp',
      modelId: 'qwen3-8b',
      fingerprint: modelFingerprint(p, m),
      settingsSummary: '',
      testedAt: '2026-09-27T10:00:00.000Z',
      durationMs: 5,
      outcome: 'passed' as const,
      checks: [],
    }
    const results = { [doctorKey('llamacpp', 'qwen3-8b')]: result }
    expect(currentDoctorResult(results, p, m)).toEqual({ result, stale: false })
    const changed = currentDoctorResult(results, provider({ base_url: 'http://x' }), m)
    expect(changed?.stale).toBe(true)
    expect(observedToolsFact(changed)).toBeNull()
    expect(observedToolsFact({ result, stale: false })?.outcome).toBe('passed')
  })
})

describe('helpers', () => {
  it('validates arguments strictly', () => {
    expect(validateProbeArgs({ city: 'Oslo', unit: 'celsius' })).toBeNull()
    expect(validateProbeArgs({ city: ' oslo ', unit: 'celsius' })).toBeNull()
    expect(validateProbeArgs({ city: 'Paris', unit: 'celsius' })).toContain('Oslo')
    expect(validateProbeArgs({ city: '', unit: 'celsius' })).toContain('city')
    expect(validateProbeArgs({ city: 'Oslo', unit: 'celsius', path: '/etc' })).toContain('path')
    expect(validateProbeArgs('Oslo')).toContain('not a JSON object')
  })

  it('redacts credential shapes from error text', () => {
    expect(describeProbeError(new Error('bad key ghp_abcdefghijklmnopqrstuvwx'))).not.toContain(
      'ghp_abcdefghijklmnop'
    )
  })
})
