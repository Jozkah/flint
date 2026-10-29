import { describe, expect, it, vi } from 'vitest'
import {
  createApiKeyRotatingFetch,
  createCustomFetch,
  DISPATCH_PARAM_KEY,
} from '@/lib/model-factory'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Characterization of the request body and headers createCustomFetch sends,
// written before the fetch wrappers moved out of model-factory.
function capture() {
  const calls: Array<{ body: unknown; headers: Headers }> = []
  const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: new Headers(init?.headers),
    })
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { base, calls }
}

const raw = {
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'ok' } },
    { type: 'function', function: { name: '  ' } },
    { type: 'function', function: {} },
  ],
}

const params = {
  temperature: '0.5',
  seed: -1,
  max_output_tokens: 0,
  samplers: 'top_k; top_p, ,min_p',
  stop: 'END\n\nSTOP',
  ctx_len: 4096,
  auto_compact: true,
  verbosity: 'low',
  dynatemp_exp: 2,
  [DISPATCH_PARAM_KEY]: {
    session: 's1',
    run: 'r1',
    thread: 't1',
    agent: 'a1',
    provider: 'p1',
  },
}

describe('createCustomFetch request body', () => {
  it('remote provider: normalises params and drops client-side keys', async () => {
    const { base, calls } = capture()
    await createCustomFetch(base, params)('http://x/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...raw, stream: true }),
    })
    expect(calls[0].body).toMatchSnapshot()
    const h = Object.fromEntries(calls[0].headers.entries())
    expect(h).toMatchSnapshot()
  })

  it('llamacpp: keeps llama-only keys and adds cache/progress flags', async () => {
    const { base, calls } = capture()
    await createCustomFetch(base, { ...params, seed: '42', grammar: '' }, true)(
      'http://x/v1/chat/completions',
      { method: 'POST', body: JSON.stringify({ ...raw, stream: true }) }
    )
    expect(calls[0].body).toMatchSnapshot()
  })

  it('GET requests pass their body through untouched', async () => {
    const { base, calls } = capture()
    await createCustomFetch(base, params)('http://x/v1/models', {
      method: 'GET',
    })
    expect(calls[0].body).toBeUndefined()
  })

  it('key rotation sets the header for each mode', async () => {
    for (const mode of [
      'authorization-bearer',
      'authorization-bearer+api-key',
      'x-api-key',
      'x-goog-api-key',
    ] as const) {
      const { base, calls } = capture()
      await createApiKeyRotatingFetch(base, ['k1', 'k2'], {}, mode)(
        'http://x/v1/chat/completions',
        { method: 'POST', body: '{}' }
      )
      expect(Object.fromEntries(calls[0].headers.entries())).toMatchSnapshot(
        mode
      )
    }
  })
})
