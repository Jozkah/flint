import { describe, it, expect } from 'vitest'
import {
  isGenuineOpenAIHost,
  isResponsesOnlyModelId,
  resolveApiFormat,
  shouldSwitchApiFormat,
} from '../apiFormat'

const apiError = (statusCode: number, message: string, url = '') =>
  Object.assign(new Error(message), { statusCode, url, responseBody: message })

describe('isGenuineOpenAIHost', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['https://api.openai.com/v1', true],
    ['https://eu.api.openai.com/v1', true],
    ['https://ai.kewaii.com/v1', false],
    ['http://localhost:4000/v1', false],
    ['https://notopenai.com/v1', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isGenuineOpenAIHost(url)).toBe(expected)
  })
})

describe('isResponsesOnlyModelId', () => {
  it.each([
    'gpt-5-pro',
    'gpt-5.2-pro',
    'o3-pro',
    'o1-pro',
    'gpt-5-codex',
    'gpt-5.1-codex-max',
    'codex-mini-latest',
    'o3-deep-research',
    'o4-mini-deep-research',
    'computer-use-preview',
    'openai/gpt-5-pro',
  ])('%s is Responses-only', (id) => {
    expect(isResponsesOnlyModelId(id)).toBe(true)
  })
  it.each(['gpt-5', 'gpt-5-mini', 'gpt-4o', 'o3', 'o4-mini', 'qwen3.8-flash-next-swift', 'prompt-pro-model'])(
    '%s is not',
    (id) => {
      expect(isResponsesOnlyModelId(id)).toBe(false)
    }
  )
})

describe('resolveApiFormat', () => {
  const gateway = 'https://ai.kewaii.com/v1'
  it('defaults by host', () => {
    expect(resolveApiFormat({ baseUrl: undefined, modelId: 'gpt-5' })).toEqual({
      format: 'responses',
      source: 'host',
    })
    expect(resolveApiFormat({ baseUrl: gateway, modelId: 'gpt-5' })).toEqual({
      format: 'chat',
      source: 'host',
    })
    expect(resolveApiFormat({ baseUrl: gateway, modelId: 'x', azureV1: true }).format).toBe(
      'responses'
    )
  })
  it('hints Responses for a Responses-only id, even behind a gateway', () => {
    expect(resolveApiFormat({ baseUrl: gateway, modelId: 'openai/gpt-5-pro' })).toEqual({
      format: 'responses',
      source: 'model',
    })
  })
  it('detected beats the hint, override beats detected', () => {
    const model = { detectedApiFormat: 'chat' }
    expect(resolveApiFormat({ baseUrl: gateway, modelId: 'gpt-5-pro', model })).toEqual({
      format: 'chat',
      source: 'detected',
    })
    expect(
      resolveApiFormat({
        baseUrl: gateway,
        modelId: 'gpt-5-pro',
        model: { ...model, apiFormat: 'responses' },
      })
    ).toEqual({ format: 'responses', source: 'override' })
  })
  it('auto and junk values mean no override', () => {
    expect(
      resolveApiFormat({ baseUrl: gateway, modelId: 'x', model: { apiFormat: 'auto' } }).source
    ).toBe('host')
    expect(
      resolveApiFormat({ baseUrl: gateway, modelId: 'x', model: { apiFormat: 'nope' } }).source
    ).toBe('host')
  })
  it('never picks Responses where the endpoint cannot serve it', () => {
    expect(
      resolveApiFormat({
        baseUrl: gateway,
        modelId: 'gpt-5-pro',
        model: { apiFormat: 'responses' },
        canServeResponses: false,
      }).format
    ).toBe('chat')
  })
})

describe('shouldSwitchApiFormat', () => {
  it('leaves Responses for Chat on a missing /responses route', () => {
    expect(shouldSwitchApiFormat(apiError(404, 'Unknown endpoint', 'https://g/v1/responses'), 'responses')).toBe(true)
    expect(shouldSwitchApiFormat(apiError(405, 'Method Not Allowed', 'https://g/v1/responses'), 'responses')).toBe(true)
    expect(shouldSwitchApiFormat(apiError(404, 'Cannot POST /v1/responses'), 'responses')).toBe(true)
    expect(shouldSwitchApiFormat(apiError(400, 'The Responses API is not supported by this provider'), 'responses')).toBe(true)
  })
  it('leaves Chat for Responses when the model needs it', () => {
    expect(
      shouldSwitchApiFormat(
        apiError(404, 'This model is only supported in v1/responses and not in v1/chat/completions.'),
        'chat'
      )
    ).toBe(true)
    expect(
      shouldSwitchApiFormat(apiError(400, 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.'), 'chat')
    ).toBe(true)
  })
  it('finds the status on a wrapped cause', () => {
    const wrapped = new Error('Failed', { cause: apiError(404, 'Unknown endpoint', 'https://g/v1/responses') })
    expect(shouldSwitchApiFormat(wrapped, 'responses')).toBe(true)
  })
  it.each([401, 403, 408, 429, 500, 502, 503])('never switches on %i', (status) => {
    expect(shouldSwitchApiFormat(apiError(status, 'Unknown endpoint /v1/responses'), 'responses')).toBe(false)
    expect(shouldSwitchApiFormat(apiError(status, 'only supported in v1/responses'), 'chat')).toBe(false)
  })
  it('does not switch for a missing model or an unrelated 400', () => {
    expect(shouldSwitchApiFormat(apiError(404, 'The model `x` does not exist', 'https://g/v1/responses'), 'responses')).toBe(false)
    expect(shouldSwitchApiFormat(apiError(400, 'max_tokens is too large'), 'chat')).toBe(false)
    expect(shouldSwitchApiFormat(new Error('network down'), 'responses')).toBe(false)
    expect(shouldSwitchApiFormat(undefined, 'chat')).toBe(false)
  })
})
