import { describe, it, expect, vi } from 'vitest'
import {
  MAX_CHOSEN_PERSONA_CHARS,
  MAX_INHERITED_PERSONA_CHARS,
  capPersona,
  prepareChildChoice,
  resolveModelArg,
  type ChoiceDeps,
} from '../subagentChoice'
import { DEFAULT_SUBAGENT_SETTINGS, PERMISSION_NOTE, type SubagentSettings } from '../subagentSettings'

const parentModel = { provider: 'p', id: 'big' }
const deps = (settings: Partial<SubagentSettings> = {}, over: Partial<ChoiceDeps> = {}): ChoiceDeps => ({
  settings: () => ({ ...DEFAULT_SUBAGENT_SETTINGS, ...settings }),
  assistants: () => [
    { id: 'jan', name: 'Flint', instructions: 'You are Flint.' },
    { id: 'terse', name: 'Terse', instructions: 'Answer in one line.' },
  ],
  profileText: (id) => `text for ${id}`,
  models: () => [
    { provider: 'p', id: 'cheap' },
    { provider: 'q', id: 'other' },
  ],
  createModel: vi.fn(async () => ({ model: 'cheap-instance' as never, supportsVision: true })),
  ...over,
})

describe('prepareChildChoice', () => {
  it('changes nothing for a child that inherits and has no parent persona', async () => {
    const c = await prepareChildChoice({ role: 'explorer', parentModel, deps: deps() })
    expect(c.model).toBeUndefined()
    expect(c.modelId).toBe('big')
    expect(c.extraSystem).toEqual([])
    expect(c.assistant).toBeUndefined()
  })

  it("passes the parent's persona to a child that inherits it", async () => {
    const c = await prepareChildChoice({
      role: 'explorer',
      parentModel,
      parent: { assistantId: 'terse', assistantName: 'Terse', assistantInstructions: 'Answer in one line.', workProfile: 'review' },
      deps: deps(),
    })
    expect(c.assistant).toEqual({ id: 'terse', name: 'Terse' })
    expect(c.profile).toBe('review')
    expect(c.extraSystem[0]).toContain('Answer in one line.')
    expect(c.extraSystem[1]).toContain('text for review')
    expect(c.sources.assistant).toBe('parent')
  })

  it('uses a chosen assistant and profile, each with the no-new-permissions note', async () => {
    const c = await prepareChildChoice({
      role: 'explorer',
      parentModel,
      deps: deps({ global: { assistantId: 'terse', workProfile: 'explain' } }),
    })
    expect(c.assistant?.name).toBe('Terse')
    expect(c.extraSystem).toHaveLength(2)
    for (const block of c.extraSystem) expect(block).toContain(PERMISSION_NOTE)
  })

  it('treats the built-in Flint assistant as the baseline, not a persona', async () => {
    const c = await prepareChildChoice({ role: 'explorer', parentModel, deps: deps({ global: { assistantId: 'jan' } }) })
    expect(c.assistant).toEqual({ id: 'jan', name: 'Flint' })
    expect(c.extraSystem).toEqual([])
  })

  it('runs a role on another model when its setting names one', async () => {
    const d = deps({ roles: { explorer: { model: { provider: 'p', id: 'cheap' } } } })
    const c = await prepareChildChoice({ role: 'explorer', parentModel, deps: d })
    expect(c.model).toBe('cheap-instance')
    expect(c.modelId).toBe('cheap')
    expect(c.supportsVision).toBe(true)
    expect(c.sources.model).toBe('role')
    const other = await prepareChildChoice({ role: 'tester', parentModel, deps: d })
    expect(other.model).toBeUndefined()
  })

  it("does not create a second instance for the parent's own model", async () => {
    const d = deps({ global: { model: { provider: 'p', id: 'big' } } })
    const c = await prepareChildChoice({ role: 'explorer', parentModel, deps: d })
    expect(c.model).toBeUndefined()
    expect(d.createModel).not.toHaveBeenCalled()
  })

  it("falls back to the parent's model and says so when the chosen one is unavailable", async () => {
    const unavailable = deps(
      { global: { model: { provider: 'p', id: 'gone' } } },
      { createModel: async () => null }
    )
    const c = await prepareChildChoice({ role: 'explorer', parentModel, deps: unavailable })
    expect(c.model).toBeUndefined()
    expect(c.modelId).toBe('big')
    expect(c.note).toContain('gone')
    const failing = deps(
      { global: { model: { provider: 'p', id: 'broken' } } },
      { createModel: async () => { throw new Error('load failed') } }
    )
    const f = await prepareChildChoice({ role: 'explorer', parentModel, deps: failing })
    expect(f.modelId).toBe('big')
    expect(f.note).toContain('load failed')
  })

  it('exposes nothing about tools or permissions', async () => {
    const c = await prepareChildChoice({ role: 'explorer', parentModel, deps: deps({ global: { workProfile: 'execute' } }) })
    expect(Object.keys(c)).not.toEqual(expect.arrayContaining(['tools', 'allowedTools', 'permissions']))
  })
})

describe('the per-call model argument', () => {
  it('resolves a configured id or provider/id, and nothing else', () => {
    const models = [{ provider: 'p', id: 'cheap' }, { provider: 'q', id: 'other' }]
    expect(resolveModelArg('cheap', models)).toEqual(models[0])
    expect(resolveModelArg('q/other', models)).toEqual(models[1])
    expect(resolveModelArg('p::cheap', models)).toEqual(models[0])
    expect(resolveModelArg('gpt-9', models)).toBeUndefined()
    expect(resolveModelArg('  ', models)).toBeUndefined()
    expect(resolveModelArg(undefined, models)).toBeUndefined()
  })

  it('is the explicit tier: it beats a role and global setting', async () => {
    const d = deps({ roles: { explorer: { model: { provider: 'p', id: 'cheap' } } }, global: { model: { provider: 'q', id: 'other' } } })
    const c = await prepareChildChoice({ role: 'explorer', parentModel, requestedModel: 'other', deps: d })
    expect(c.modelId).toBe('other')
    expect(c.sources.model).toBe('tool')
    expect(c.note).toBeUndefined()
  })

  it('falls back with a visible note for an unknown model', async () => {
    const c = await prepareChildChoice({ role: 'explorer', parentModel, requestedModel: 'gpt-9', deps: deps() })
    expect(c.model).toBeUndefined()
    expect(c.modelId).toBe('big')
    expect(c.note).toContain('gpt-9')
  })

  it('is ignored, with a note, when the settings say they always win', async () => {
    const c = await prepareChildChoice({
      role: 'explorer',
      parentModel,
      requestedModel: 'cheap',
      deps: deps({ letModelChoose: false, global: { model: { provider: 'q', id: 'other' } } }),
    })
    expect(c.modelId).toBe('other')
    expect(c.note).toContain('settings choose')
  })

  it('cannot name a model the user has not configured, so it cannot reach a provider that is not set up', async () => {
    const d = deps({}, { models: () => [] })
    const c = await prepareChildChoice({ role: 'explorer', parentModel, requestedModel: 'cheap', deps: d })
    expect(c.model).toBeUndefined()
    expect(d.createModel).not.toHaveBeenCalled()
  })
})

describe('inherited personas', () => {
  it('caps a long inherited persona, after the role prompt, and says it was shortened', async () => {
    const long = 'Be terse. '.repeat(600)
    const c = await prepareChildChoice({
      role: 'explorer',
      parentModel,
      parent: { assistantId: 'terse', assistantName: 'Terse', assistantInstructions: long },
      deps: deps(),
    })
    expect(c.inherited).toEqual({ assistant: true, profile: false })
    const block = c.extraSystem[0]
    expect(block.length).toBeLessThan(MAX_INHERITED_PERSONA_CHARS + 400)
    expect(block).toContain('Persona shortened')
    expect(block).toContain('does not change which tools')
  })

  it('does not mark a chosen assistant or profile as inherited', async () => {
    const c = await prepareChildChoice({
      role: 'explorer',
      parentModel,
      parent: { assistantId: 'terse', assistantName: 'Terse', assistantInstructions: 'x', workProfile: 'plan' },
      deps: deps({ global: { assistantId: 'terse', workProfile: 'review' } }),
    })
    expect(c.inherited).toEqual({ assistant: false, profile: false })
  })

  it('capPersona keeps short text whole and cuts long text at a word edge', () => {
    expect(capPersona('  short  ', 100)).toBe('short')
    expect(capPersona('   ', 100)).toBeUndefined()
    const cut = capPersona('word '.repeat(100), 50)!
    expect(cut.startsWith('word word')).toBe(true)
    expect(cut.length).toBeLessThan(50 + 40)
    expect(MAX_CHOSEN_PERSONA_CHARS).toBeGreaterThan(MAX_INHERITED_PERSONA_CHARS)
  })
})
