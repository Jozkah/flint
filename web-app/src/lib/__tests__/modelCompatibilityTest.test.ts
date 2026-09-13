import { describe, it, expect, vi } from 'vitest'
import {
  planCompatibilityTest,
  runCompatibilityTest,
  metricsFromResponse,
  type CompatibilityTestDeps,
} from '../modelCompatibilityTest'

// Mock-backed: these tests drive the runner against fake engine functions.
// They prove the sequencing and resource handling, not that a real model loads.

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 })

function deps(overrides: Partial<CompatibilityTestDeps> = {}) {
  let clock = 0
  const base: CompatibilityTestDeps = {
    getActiveModels: vi.fn().mockResolvedValue([]),
    startModel: vi.fn().mockImplementation(async () => {
      clock += 1200
    }),
    stopModel: vi.fn().mockResolvedValue(undefined),
    findSession: vi.fn().mockResolvedValue({ port: 3900, api_key: 'k' }),
    fetch: vi.fn().mockImplementation(async () => {
      clock += 300
      return okResponse({
        choices: [{ message: { content: 'ready' } }],
        usage: { prompt_tokens: 12, completion_tokens: 2 },
        timings: { predicted_per_second: 41.5 },
      })
    }) as unknown as typeof fetch,
    now: () => clock,
  }
  return { ...base, ...overrides }
}

const request = (overrides = {}) => ({
  modelId: 'qwen3-8b',
  modelsMax: 1,
  allowUnload: [] as string[],
  signal: new AbortController().signal,
  ...overrides,
})

describe('planCompatibilityTest', () => {
  it('needs nothing unloaded when the model is already loaded', () => {
    expect(planCompatibilityTest(['qwen3-8b', 'other'], 'qwen3-8b', 1)).toEqual({
      alreadyLoaded: true,
      willUnload: [],
      staysLoaded: ['other'],
    })
  })

  it('names every model the engine could evict at the models_max cap', () => {
    expect(planCompatibilityTest(['a'], 'b', 1).willUnload).toEqual(['a'])
    expect(planCompatibilityTest(['a'], 'b', 2).willUnload).toEqual([])
    expect(planCompatibilityTest(['a', 'c'], 'b', 0).willUnload).toEqual([])
  })
})

describe('runCompatibilityTest', () => {
  it('loads, runs one short request, records reported metrics and releases', async () => {
    const d = deps()
    const outcome = await runCompatibilityTest(request(), d)
    expect(outcome).toMatchObject({
      kind: 'completed',
      outcome: 'success',
      released: true,
      metrics: {
        loadMs: 1200,
        requestMs: 300,
        promptTokens: 12,
        completionTokens: 2,
        generationTokensPerSecond: 41.5,
      },
    })
    expect(d.startModel).toHaveBeenCalledWith('qwen3-8b')
    expect(d.stopModel).toHaveBeenCalledWith('qwen3-8b')
    const body = JSON.parse(
      (vi.mocked(d.fetch).mock.calls[0][1] as RequestInit).body as string
    )
    expect(body.max_tokens).toBe(16)
  })

  it('does not report metrics the engine did not return', () => {
    expect(metricsFromResponse({ choices: [{}] })).toEqual({})
  })

  it('asks before a test would unload another model, and does nothing meanwhile', async () => {
    const d = deps({ getActiveModels: vi.fn().mockResolvedValue(['busy-model']) })
    const outcome = await runCompatibilityTest(request(), d)
    expect(outcome).toEqual({
      kind: 'needs-confirmation',
      plan: { alreadyLoaded: false, willUnload: ['busy-model'], staysLoaded: [] },
    })
    expect(d.startModel).not.toHaveBeenCalled()
    expect(d.stopModel).not.toHaveBeenCalled()
  })

  it('proceeds once the user has agreed to unload the named model', async () => {
    const d = deps({ getActiveModels: vi.fn().mockResolvedValue(['busy-model']) })
    const outcome = await runCompatibilityTest(
      request({ allowUnload: ['busy-model'] }),
      d
    )
    expect(outcome).toMatchObject({ kind: 'completed', unloadedModels: ['busy-model'] })
  })

  it('leaves an already loaded model loaded', async () => {
    const d = deps({ getActiveModels: vi.fn().mockResolvedValue(['qwen3-8b']) })
    const outcome = await runCompatibilityTest(request(), d)
    expect(outcome).toMatchObject({ kind: 'completed', outcome: 'success' })
    expect(d.startModel).not.toHaveBeenCalled()
    expect(d.stopModel).not.toHaveBeenCalled()
  })

  it('records a load failure with the engine error code', async () => {
    const d = deps({
      startModel: vi.fn().mockRejectedValue({
        code: 'OUT_OF_MEMORY',
        message: 'Not enough memory',
      }),
    })
    const outcome = await runCompatibilityTest(request(), d)
    expect(outcome).toMatchObject({
      kind: 'completed',
      outcome: 'failure',
      error: { code: 'OUT_OF_MEMORY', message: 'Not enough memory' },
    })
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('treats a non-OK engine reply as a failure, not a success', async () => {
    const d = deps({
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('context too large', { status: 400 })) as unknown as typeof fetch,
    })
    const outcome = await runCompatibilityTest(request(), d)
    expect(outcome).toMatchObject({ kind: 'completed', outcome: 'failure' })
    expect((outcome as { error: { message: string } }).error.message).toContain('HTTP 400')
    expect(d.stopModel).toHaveBeenCalled()
  })

  it('cancelled before starting does nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const d = deps()
    expect(await runCompatibilityTest(request({ signal: controller.signal }), d)).toEqual({
      kind: 'cancelled',
      released: true,
    })
    expect(d.getActiveModels).not.toHaveBeenCalled()
  })

  it('cancelled during load releases the model once loading returns', async () => {
    const controller = new AbortController()
    const d = deps({
      startModel: vi.fn().mockImplementation(async () => {
        controller.abort()
      }),
    })
    const outcome = await runCompatibilityTest(request({ signal: controller.signal }), d)
    expect(outcome).toEqual({ kind: 'cancelled', released: true })
    expect(d.stopModel).toHaveBeenCalledWith('qwen3-8b')
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('cancelled during the request aborts it and releases', async () => {
    const controller = new AbortController()
    const d = deps({
      fetch: vi.fn().mockImplementation(async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      }) as unknown as typeof fetch,
    })
    const outcome = await runCompatibilityTest(request({ signal: controller.signal }), d)
    expect(outcome).toEqual({ kind: 'cancelled', released: true })
    expect(d.stopModel).toHaveBeenCalled()
  })

  it('says so when it could not release what it loaded', async () => {
    const d = deps({ stopModel: vi.fn().mockRejectedValue(new Error('busy')) })
    const outcome = await runCompatibilityTest(request(), d)
    expect(outcome).toMatchObject({ kind: 'completed', outcome: 'success', released: false })
  })
})
