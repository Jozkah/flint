import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/jev', () => ({
  jevSuggestModel: vi.fn(),
  shouldAskForSkill: (t: string) => t.trim().length >= 20 && !t.trim().startsWith('/'),
}))

import {
  chooseJevModel,
  describeModel,
  eligibleTargets,
  messageNeeds,
  modelKey,
  resolvePool,
  type ModelTarget,
} from '../jevModelRouting'

const local: ModelTarget = { provider: 'llamacpp', model: 'qwen3-8b', label: 'Llama.cpp / Qwen3 8B', local: true, capabilities: ['tools'] }
const hosted: ModelTarget = { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Anthropic / Sonnet', local: false, capabilities: ['tools', 'vision', 'reasoning'], note: 'Best for code and long documents' }
const noTools: ModelTarget = { provider: 'groq', model: 'small', label: 'Groq / small', local: false, capabilities: [] }
const current = { provider: 'llamacpp', model: 'gemma-4', label: 'Llama.cpp / Gemma 4', local: true, capabilities: ['tools'] }

describe('resolvePool', () => {
  const providers = [
    { provider: 'llamacpp', active: true, models: [{ id: 'qwen3-8b', displayName: 'Qwen3 8B', capabilities: ['tools'] }] },
    { provider: 'anthropic', active: true, api_key: 'k', models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', capabilities: ['tools', 'vision'] }] },
    { provider: 'groq', active: true, models: [{ id: 'small' }] },
    { provider: 'xai', active: false, api_key: 'k', models: [{ id: 'grok' }] },
  ]

  it('keeps usable models and drops a hosted one without a key, an inactive provider and a model that is gone', () => {
    const pool = resolvePool(
      [
        { provider: 'llamacpp', model: 'qwen3-8b' },
        { provider: 'anthropic', model: 'claude-sonnet-5-5', note: 'code' },
        { provider: 'groq', model: 'small' },
        { provider: 'xai', model: 'grok' },
        { provider: 'llamacpp', model: 'removed' },
        { provider: 'nobody', model: 'x' },
      ],
      providers
    )
    expect(pool.map((m) => modelKey(m.provider, m.model))).toEqual(['llamacpp/qwen3-8b', 'anthropic/claude-sonnet-5-5'])
    expect(pool[0].local).toBe(true)
    expect(pool[1].note).toBe('code')
    expect(pool[0].label).toContain('Qwen3 8B')
  })
})

describe('eligibleTargets', () => {
  it('never offers the model already in use', () => {
    expect(eligibleTargets([local, hosted], { provider: 'llamacpp', model: 'qwen3-8b' }, { tools: false, vision: false })).toEqual([hosted])
  })

  it('offers only models that can use tools when the message needs them, and only ones that see images for an image', () => {
    expect(eligibleTargets([local, hosted, noTools], null, { tools: true, vision: false })).toEqual([local, hosted])
    expect(eligibleTargets([local, hosted, noTools], null, { tools: false, vision: true })).toEqual([hosted])
    expect(eligibleTargets([noTools], null, { tools: false, vision: false })).toEqual([noTools])
  })
})

describe('describeModel', () => {
  it('says where it runs, what it can do and the person\'s note', () => {
    expect(describeModel(local)).toBe('Runs on this computer (tools).')
    expect(describeModel(hosted)).toBe('Hosted by Anthropic (tools, vision, reasoning). Best for code and long documents')
  })
})

describe('messageNeeds', () => {
  it('needs tools when the current model has them and vision when an image is attached', () => {
    expect(messageNeeds([{ type: 'text' }], ['tools'])).toEqual({ tools: true, vision: false })
    expect(messageNeeds([{ type: 'text' }, { type: 'file', mediaType: 'image/png' }], [])).toEqual({ tools: false, vision: true })
    expect(messageNeeds([{ type: 'file', mediaType: 'application/pdf' }], [])).toEqual({ tools: false, vision: false })
  })
})

describe('chooseJevModel', () => {
  const message = 'Please refactor this module and add unit tests for it'
  const base = { message, current, pool: [local, hosted, noTools], needs: { tools: true, vision: false } }

  it('names the model Jev found clearly better', async () => {
    const suggest = vi.fn(async () => ({ skill: 'anthropic/claude-sonnet-5-5', probability: 0.9, fallback: null, model: 'j' }))
    const decision = await chooseJevModel({ ...base, suggest })
    expect(decision?.target?.model).toBe('claude-sonnet-5-5')
    const [, cur, options] = suggest.mock.calls[0] as unknown as [string, { name: string }, Array<{ name: string }>]
    expect(cur.name).toBe('Llama.cpp / Gemma 4')
    // The model without tools is not offered to replace one that has them.
    expect(options.map((o) => o.name)).toEqual(['llamacpp/qwen3-8b', 'anthropic/claude-sonnet-5-5'])
  })

  it('keeps the current model when Jev abstains or names something that was not offered', async () => {
    const none = vi.fn(async () => ({ skill: null, probability: 0.4, fallback: 'abstained', model: 'j' }))
    expect((await chooseJevModel({ ...base, suggest: none }))?.target).toBeNull()
    const stray = vi.fn(async () => ({ skill: 'groq/small', probability: 0.99, fallback: null, model: 'j' }))
    expect((await chooseJevModel({ ...base, suggest: stray }))?.target).toBeNull()
  })

  it('asks nothing for a short message, without candidates, or when stopped; and never throws', async () => {
    const suggest = vi.fn(async () => ({ skill: 'anthropic/claude-sonnet-5-5', probability: 0.9, fallback: null, model: 'j' }))
    expect(await chooseJevModel({ ...base, message: 'hi', suggest })).toBeNull()
    expect(await chooseJevModel({ ...base, pool: [], suggest })).toBeNull()
    const stop = new AbortController()
    stop.abort()
    expect(await chooseJevModel({ ...base, signal: stop.signal, suggest })).toBeNull()
    expect(suggest).not.toHaveBeenCalled()
    const broken = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await chooseJevModel({ ...base, suggest: broken })).toBeNull()
  })
})
