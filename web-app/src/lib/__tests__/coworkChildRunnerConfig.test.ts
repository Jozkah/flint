import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepareChildChoice: vi.fn(),
  resolveChildEffort: vi.fn(),
  checkLaunch: vi.fn(),
}))

vi.mock('@/lib/subagentChoice', async (orig) => ({
  ...(await orig<typeof import('@/lib/subagentChoice')>()),
  prepareChildChoice: mocks.prepareChildChoice,
}))
vi.mock('@/lib/coworkSubagentEffort', async (orig) => ({
  ...(await orig<typeof import('@/lib/coworkSubagentEffort')>()),
  resolveChildEffort: mocks.resolveChildEffort,
}))
vi.mock('@/lib/coworkSubagentLaunchGate', async (orig) => ({
  ...(await orig<typeof import('@/lib/coworkSubagentLaunchGate')>()),
  checkLaunch: mocks.checkLaunch,
}))

import { askEditingChildApproval, forkRefusal, resolveChildConfig } from '../coworkChildRunner'

const env = { providerId: 'openai', modelId: 'parent-model', parent: () => undefined }

describe('forkRefusal', () => {
  const ok = { available: true, background: false, callerDepth: 0, resuming: false }
  it.each([
    [{ ...ok, available: false }, 'fork is not available on this surface'],
    [{ ...ok, background: true }, 'a forked subagent runs in the foreground only'],
    [{ ...ok, callerDepth: 1 }, 'a subagent cannot fork'],
    [{ ...ok, resuming: true }, 'a fork cannot be resumed'],
    [ok, null],
  ])('%o -> %s', (input, why) => {
    expect(forkRefusal(input)).toBe(why)
  })

  it('reports the first reason in the original order', () => {
    expect(forkRefusal({ available: false, background: true, callerDepth: 2, resuming: true })).toBe(
      'fork is not available on this surface'
    )
  })
})

describe('resolveChildConfig', () => {
  beforeEach(() => {
    mocks.prepareChildChoice.mockReset()
    mocks.resolveChildEffort.mockReset()
    mocks.prepareChildChoice.mockImplementation(async (input) => ({
      providerId: 'openai',
      modelId: input.requestedModel ?? 'settings-model',
      note: 'from settings',
      inherited: {},
    }))
  })

  it('takes the subagent settings over the parent, and the requested model when not forking', async () => {
    const { choice, effortChoice } = await resolveChildConfig(env, { name: 'reviewer' }, { model: 'asked' }, false)
    expect(mocks.prepareChildChoice).toHaveBeenCalledWith({
      role: 'reviewer',
      parentModel: { provider: 'openai', id: 'parent-model' },
      parent: undefined,
      requestedModel: 'asked',
    })
    expect(choice.modelId).toBe('asked')
    expect(effortChoice).toBeUndefined()
  })

  it('applies an effort override and joins its note', async () => {
    mocks.resolveChildEffort.mockResolvedValue({ note: 'effort high' })
    const { choice, effortChoice } = await resolveChildConfig(
      env,
      { name: 'r', effort: 'high' } as never,
      {},
      false
    )
    expect(mocks.resolveChildEffort).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'settings-model', level: 'high' })
    expect(effortChoice).toEqual({ note: 'effort high' })
    expect(choice.note).toBe('from settings; effort high')
  })

  it('a fork ignores the requested model and the effort', async () => {
    await resolveChildConfig(env, { name: 'r', effort: 'high' } as never, { model: 'asked' }, true)
    expect(mocks.prepareChildChoice.mock.calls[0][0].requestedModel).toBeUndefined()
    expect(mocks.resolveChildEffort).not.toHaveBeenCalled()
  })
})

describe('askEditingChildApproval', () => {
  const resolved = { name: 'editor', allowedTools: undefined } as never
  const launch = { spawn: { depth: 1, maxDepth: 1 }, model: 'm', foreground: true }

  it('lets a child start on a surface without a gate', async () => {
    mocks.checkLaunch.mockReset()
    const ok = await askEditingChildApproval(
      { sessionId: 's', parentTools: () => ({}), signal: new AbortController().signal },
      resolved,
      launch
    )
    expect(ok).toBe(true)
    expect(mocks.checkLaunch).not.toHaveBeenCalled()
  })

  it('asks the gate and returns its answer', async () => {
    mocks.checkLaunch.mockReset().mockResolvedValue(false)
    const ok = await askEditingChildApproval(
      {
        sessionId: 's',
        parentTools: () => ({}),
        signal: new AbortController().signal,
        launchGate: { mode: () => 'ask' as never, ask: async () => true },
      },
      resolved,
      launch
    )
    expect(ok).toBe(false)
    expect(mocks.checkLaunch.mock.calls[0][0]).toMatchObject({ sessionId: 's', agent: 'editor', model: 'm', foreground: true })
  })
})
