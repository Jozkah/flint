import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import type { ProviderObject } from '@janhq/core'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: { models: () => ({}) } }) },
}))

import { ModelFactory } from '../model-factory'
import { bedrockRegion } from '../bedrock'
import { predefinedProviders } from '@/constants/providers'

const bedrock = (base_url: string): ProviderObject =>
  ({
    ...(predefinedProviders.find((p) => p.provider === 'bedrock') as unknown as ProviderObject),
    base_url,
  }) as ProviderObject

let seen: { url: string; headers: Record<string, string>; body: string }[] = []

beforeEach(() => {
  seen = []
  invoke.mockReset()
  invoke.mockResolvedValue({
    authorization: 'AWS4-HMAC-SHA256 Credential=TEST/20260101/eu-west-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc',
    'x-amz-date': '20260101T000000Z',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
      seen.push({ url: String(input), headers, body: String(init?.body ?? '') })
      return new Response(
        JSON.stringify({
          output: { message: { role: 'assistant', content: [{ text: 'hi' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
  )
})

describe('Amazon Bedrock', () => {
  it('reads the region from the endpoint host only', () => {
    expect(bedrockRegion('https://bedrock-runtime.eu-west-1.amazonaws.com')).toBe('eu-west-1')
    expect(bedrockRegion('https://example.com')).toBeUndefined()
    expect(bedrockRegion('https://bedrock-runtime.eu-west-1.amazonaws.com.evil.test')).toBeUndefined()
  })

  it('the preset points at a regional bedrock-runtime endpoint', () => {
    expect(bedrockRegion(predefinedProviders.find((p) => p.provider === 'bedrock')!.base_url)).toBe('us-east-1')
  })

  it('rejects a base URL that is not a bedrock-runtime host', async () => {
    await expect(
      ModelFactory.createModel('m', bedrock('https://example.com'), {})
    ).rejects.toThrow(/bedrock-runtime/)
  })

  it('sends Converse requests to the regional host with a backend signature', async () => {
    const model = await ModelFactory.createModel(
      'anthropic.claude-3-5-sonnet-20240620-v1:0',
      bedrock('https://bedrock-runtime.eu-west-1.amazonaws.com'),
      {}
    )
    await generateText({ model, prompt: 'hello', maxRetries: 0 })

    const req = seen[0]!
    expect(req.url).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse'
    )
    // Signed by the backend, not by a bearer placeholder.
    expect(req.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(req.headers['x-amz-date']).toBe('20260101T000000Z')

    const [cmd, args] = invoke.mock.calls.find((c) => c[0] === 'bedrock_sign')!
    expect(cmd).toBe('bedrock_sign')
    expect(args.method).toBe('POST')
    expect(args.url).toBe(req.url)
    expect(JSON.parse(args.body).messages[0].content[0].text).toBe('hello')
  })
  it('signs the exact body that reaches the wire and keeps OpenAI params out of it', async () => {
    const model = await ModelFactory.createModel(
      'anthropic.claude-3-5-sonnet-20240620-v1:0',
      bedrock('https://bedrock-runtime.eu-west-1.amazonaws.com'),
      { temperature: 0.5, top_p: 0.9, seed: 3, max_tokens: 100 }
    )
    await generateText({ model, prompt: 'hello', maxRetries: 0 })

    const [, args] = invoke.mock.calls.find((c) => c[0] === 'bedrock_sign')!
    expect(seen[0]!.body).toBe(args.body)
    const sent = JSON.parse(seen[0]!.body)
    for (const k of ['temperature', 'top_p', 'seed', 'max_tokens']) {
      expect(sent).not.toHaveProperty(k)
    }
  })

  it('maps sampling params into inferenceConfig before signing', async () => {
    const model = await ModelFactory.createModel(
      'anthropic.claude-3-5-sonnet-20240620-v1:0',
      bedrock('https://bedrock-runtime.eu-west-1.amazonaws.com'),
      { temperature: '0.5', top_p: 0.9, seed: 3, max_output_tokens: 100, stop: 'END\nSTOP' }
    )
    await generateText({ model, prompt: 'hello', maxRetries: 0 })

    const [, args] = invoke.mock.calls.find((c) => c[0] === 'bedrock_sign')!
    // signed payload is exactly the sent body
    expect(seen[0]!.body).toBe(args.body)
    const sent = JSON.parse(seen[0]!.body)
    expect(sent.inferenceConfig).toEqual({
      maxTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ['END', 'STOP'],
    })
    for (const k of ['temperature', 'top_p', 'seed', 'max_tokens', 'stop']) {
      expect(sent).not.toHaveProperty(k)
    }
  })

  it('call-level settings win over assistant params', async () => {
    const model = await ModelFactory.createModel(
      'm',
      bedrock('https://bedrock-runtime.eu-west-1.amazonaws.com'),
      { temperature: 0.5, max_output_tokens: 100 }
    )
    await generateText({ model, prompt: 'hello', maxRetries: 0, maxOutputTokens: 7 })
    const sent = JSON.parse(seen[0]!.body)
    expect(sent.inferenceConfig.maxTokens).toBe(7)
    expect(sent.inferenceConfig.temperature).toBe(0.5)
  })
})
