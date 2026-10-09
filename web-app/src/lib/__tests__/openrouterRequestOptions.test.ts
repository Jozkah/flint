import { describe, expect, it, vi } from 'vitest'
import {
  applyOpenRouterOptions,
  parseProviderRouting,
  withOpenRouterOptions,
} from '../openrouterRequestOptions'
import {
  buildVerbosityProviderOptions,
  mergeProviderOptions,
} from '../reasoningProviderOptions'
import { createCustomFetch } from '../model-factory'

describe('parseProviderRouting', () => {
  it('keeps only documented, well-typed fields', () => {
    expect(
      parseProviderRouting(
        '{"order":["openai",1],"allow_fallbacks":false,"only":[],"x":1}'
      )
    ).toEqual({ order: ['openai'], allow_fallbacks: false })
  })
  it('ignores empty or invalid input', () => {
    expect(parseProviderRouting('')).toBeUndefined()
    expect(parseProviderRouting('{bad')).toBeUndefined()
    expect(parseProviderRouting('[1]')).toBeUndefined()
  })
})

describe('applyOpenRouterOptions', () => {
  it('appends :online once and sets provider', () => {
    const body: Record<string, unknown> = { model: 'openai/gpt-5' }
    const params = {
      openrouter_web_search: true,
      openrouter_provider: '{"order":["azure"]}',
    }
    expect(applyOpenRouterOptions(body, params)).toBe(true)
    expect(body).toEqual({
      model: 'openai/gpt-5:online',
      provider: { order: ['azure'] },
    })
    expect(applyOpenRouterOptions(body, params)).toBe(false)
  })
  it('does nothing when unset', () => {
    const body = { model: 'a/b' }
    expect(applyOpenRouterOptions(body, {})).toBe(false)
    expect(body).toEqual({ model: 'a/b' })
  })
  it('rewrites the request body through the fetch wrapper', async () => {
    const inner = vi.fn(async () => new Response('{}'))
    await withOpenRouterOptions(inner as never, { openrouter_web_search: true })(
      'http://x',
      { method: 'POST', body: JSON.stringify({ model: 'a/b' }) }
    )
    const sent = JSON.parse(
      ((inner.mock.calls[0] as unknown[])[1] as RequestInit).body as string
    )
    expect(sent.model).toBe('a/b:online')
  })
})

describe('verbosity provider options', () => {
  it('applies to openai gpt-5 only', () => {
    expect(buildVerbosityProviderOptions('openai', 'gpt-5-mini', { verbosity: 'low' })).toEqual({
      openai: { textVerbosity: 'low' },
    })
    expect(buildVerbosityProviderOptions('openai', 'gpt-4o', { verbosity: 'low' })).toBeUndefined()
    expect(buildVerbosityProviderOptions('openrouter', 'gpt-5', { verbosity: 'low' })).toBeUndefined()
    expect(buildVerbosityProviderOptions('openai', 'gpt-5', { verbosity: 'loud' })).toBeUndefined()
  })
  it('merges provider option maps', () => {
    expect(
      mergeProviderOptions(
        { openai: { reasoningEffort: 'low' } },
        { openai: { textVerbosity: 'high' } }
      )
    ).toEqual({ openai: { reasoningEffort: 'low', textVerbosity: 'high' } })
    expect(mergeProviderOptions(undefined, undefined)).toBeUndefined()
  })
})

describe('stop sequences and client-side keys in the request body', () => {
  it('sends stop as an array and drops client-side keys', async () => {
    const base = vi.fn(async () => new Response('{}'))
    await createCustomFetch(base as never, {
      stop: 'END\n</answer>\n',
      verbosity: 'low',
      openrouter_web_search: true,
    })('http://x', { method: 'POST', body: JSON.stringify({ messages: [] }) })
    const body = JSON.parse(
      ((base.mock.calls[0] as unknown[])[1] as RequestInit).body as string
    )
    expect(body.stop).toEqual(['END', '</answer>'])
    expect(body.verbosity).toBeUndefined()
    expect(body.openrouter_web_search).toBeUndefined()
  })
})
