import { describe, it, expect, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { withApiFormatFallback } from '../apiFormatFallback'

const apiError = (statusCode: number, message: string, url = '') =>
  Object.assign(new Error(message), { statusCode, url, responseBody: message })

const model = (tag: string, fail?: Error) => {
  const m = {
    specificationVersion: 'v3',
    provider: tag,
    modelId: 'm',
    doGenerate: vi.fn(async () => {
      if (fail) throw fail
      return { tag }
    }),
    doStream: vi.fn(async () => {
      if (fail) throw fail
      return { tag, stream: true }
    }),
  }
  return m
}

const as = (m: unknown) => m as unknown as LanguageModel
const call = (m: LanguageModel, method: 'doGenerate' | 'doStream' = 'doStream') =>
  (m as unknown as Record<string, (o: unknown) => Promise<unknown>>)[method]!({})

const missing = () => apiError(404, 'Unknown endpoint', 'https://g/v1/responses')
const needsResponses = () =>
  apiError(404, 'This model is only supported in v1/responses and not in v1/chat/completions.')

describe('withApiFormatFallback', () => {
  it('passes properties through and does nothing while the model works', async () => {
    const primary = model('responses')
    const onSwitched = vi.fn()
    const wrapped = withApiFormatFallback(as(primary), {
      format: 'responses',
      buildAlternate: vi.fn(),
      onSwitched,
    })
    expect((wrapped as unknown as { provider: string }).provider).toBe('responses')
    await expect(call(wrapped)).resolves.toEqual({ tag: 'responses', stream: true })
    expect(onSwitched).not.toHaveBeenCalled()
  })

  it('retries once on Chat after a 404 on /responses, and sticks to it', async () => {
    const primary = model('responses', missing())
    const alternate = model('chat')
    const build = vi.fn(() => as(alternate))
    const onSwitched = vi.fn()
    const wrapped = withApiFormatFallback(as(primary), {
      format: 'responses',
      buildAlternate: build,
      onSwitched,
    })
    await expect(call(wrapped)).resolves.toEqual({ tag: 'chat', stream: true })
    expect(build).toHaveBeenCalledWith('chat')
    expect(onSwitched).toHaveBeenCalledWith('chat', 'responses')
    // The next call goes straight to the working API.
    await call(wrapped, 'doGenerate')
    expect(primary.doStream).toHaveBeenCalledTimes(1)
    expect(primary.doGenerate).not.toHaveBeenCalled()
    expect(alternate.doGenerate).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('moves to Responses when Chat says the model needs it', async () => {
    const onSwitched = vi.fn()
    const wrapped = withApiFormatFallback(as(model('chat', needsResponses())), {
      format: 'chat',
      buildAlternate: () => as(model('responses')),
      onSwitched,
    })
    await expect(call(wrapped, 'doGenerate')).resolves.toEqual({ tag: 'responses' })
    expect(onSwitched).toHaveBeenCalledWith('responses', 'chat')
  })

  it.each([401, 403, 429, 500, 503])('does not retry on %i', async (status) => {
    const build = vi.fn()
    const err = apiError(status, 'Unknown endpoint', 'https://g/v1/responses')
    const wrapped = withApiFormatFallback(as(model('responses', err)), {
      format: 'responses',
      buildAlternate: build,
      onSwitched: vi.fn(),
    })
    await expect(call(wrapped)).rejects.toBe(err)
    expect(build).not.toHaveBeenCalled()
  })

  it('throws the first error and remembers nothing when the other API fails too', async () => {
    const first = missing()
    const onSwitched = vi.fn()
    const wrapped = withApiFormatFallback(as(model('responses', first)), {
      format: 'responses',
      buildAlternate: () => as(model('chat', apiError(401, 'bad key'))),
      onSwitched,
    })
    await expect(call(wrapped)).rejects.toBe(first)
    expect(onSwitched).not.toHaveBeenCalled()
  })

  it('does not retry an aborted request', async () => {
    const build = vi.fn()
    const wrapped = withApiFormatFallback(as(model('responses', missing())), {
      format: 'responses',
      buildAlternate: build,
      onSwitched: vi.fn(),
    })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      (wrapped as unknown as { doStream: (o: unknown) => Promise<unknown> }).doStream({
        abortSignal: ctrl.signal,
      })
    ).rejects.toBeTruthy()
    expect(build).not.toHaveBeenCalled()
  })
})
