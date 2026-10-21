import { describe, it, expect, vi } from 'vitest'
import { resolveSubagent, parseSubagentRequest } from '../coworkSubagent'
import { resolveChildEffort } from '../coworkSubagentEffort'

const def = (over = {}) => ({
  name: 'r',
  description: 'd',
  system_prompt: 'p',
  allowed_tools: null as string[] | null,
  model: null as string | null,
  ...over,
})
const req = { subagent_name: 'r', description: 'go' }

describe('effort on a definition and a call', () => {
  it('takes the definition effort, the call winning', () => {
    expect(resolveSubagent(req, [def({ effort: 'low' })], [])).toMatchObject({ effort: 'low' })
    expect(
      resolveSubagent({ ...req, effort: 'high' as const }, [def({ effort: 'low' })], [])
    ).toMatchObject({ effort: 'high' })
  })
  it('leaves effort off a definition without it and drops junk values', () => {
    expect(resolveSubagent(req, [def()], [])).not.toHaveProperty('effort')
    expect(resolveSubagent(req, [def({ effort: 'max' })], [])).not.toHaveProperty('effort')
    expect(parseSubagentRequest({ ...req, effort: 'turbo' })).not.toHaveProperty('effort')
    expect(parseSubagentRequest({ ...req, effort: 'xhigh' })).toMatchObject({ effort: 'xhigh' })
  })
  it('a one-off with effort keeps it', () => {
    expect(
      resolveSubagent({ ...req, subagent_name: 'x', system_prompt: 's', effort: 'low' }, [], [])
    ).toMatchObject({ effort: 'low' })
  })
})

describe('resolveChildEffort', () => {
  const provider = { provider: 'openai', models: [] } as unknown as ModelProvider
  const deps = (id: string) => ({
    lookup: () => ({ provider, model: { id } as unknown as Model }),
    createModel: vi.fn().mockResolvedValue({ marker: 'child-model' }),
  })

  it('builds a model with the level for a provider that takes one', async () => {
    const d = deps('gpt-5.2')
    const out = await resolveChildEffort({ providerId: 'openai', modelId: 'gpt-5.2', level: 'high' }, d)
    expect(out).toMatchObject({ level: 'high' })
    expect('model' in out && out.providerOptions).toBeTruthy()
    expect(d.createModel).toHaveBeenCalledOnce()
  })
  it('says why when the model has no effort control', async () => {
    const d = deps('gemini-2.5')
    const out = await resolveChildEffort({ providerId: 'gemini', modelId: 'gemini-2.5', level: 'low' }, d)
    expect(out).toEqual({ note: expect.stringContaining('no effort control') })
    expect(d.createModel).not.toHaveBeenCalled()
  })
  it('clamps to what the model offers, with a note', async () => {
    const d = deps('gpt-5')
    const out = await resolveChildEffort({ providerId: 'openai', modelId: 'gpt-5', level: 'xhigh' }, d)
    expect(out).toMatchObject({ level: 'high', note: expect.stringContaining('used high') })
  })
  it('falls back with a note when the model cannot be built', async () => {
    const d = { ...deps('gpt-5.2'), createModel: vi.fn().mockRejectedValue(new Error('boom')) }
    const out = await resolveChildEffort({ providerId: 'openai', modelId: 'gpt-5.2', level: 'low' }, d)
    expect(out).toEqual({ note: expect.stringContaining('boom') })
  })
})

describe('fork on a request', () => {
  it('parses fork and resolves to the parent, not a definition', () => {
    expect(parseSubagentRequest({ ...req, fork: true })).toMatchObject({ fork: true })
    expect(parseSubagentRequest({ ...req, fork: 'yes' })).not.toHaveProperty('fork')
    expect(resolveSubagent({ ...req, fork: true }, [def({ allowed_tools: ['read'] })], ['read'])).toMatchObject({
      fork: true,
      allowedTools: null,
      systemPrompt: '',
    })
  })
})
