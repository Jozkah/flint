import { describe, it, expect, vi } from 'vitest'
import { prepareChildChoice, type ChoiceDeps } from '../subagentChoice'
import { DEFAULT_SUBAGENT_SETTINGS, PERMISSION_NOTE, type SubagentSettings } from '../subagentSettings'

const parentModel = { provider: 'p', id: 'big' }
const deps = (settings: Partial<SubagentSettings> = {}, over: Partial<ChoiceDeps> = {}): ChoiceDeps => ({
  settings: () => ({ ...DEFAULT_SUBAGENT_SETTINGS, ...settings }),
  assistants: () => [
    { id: 'jan', name: 'Flint', instructions: 'You are Flint.' },
    { id: 'terse', name: 'Terse', instructions: 'Answer in one line.' },
  ],
  profileText: (id) => `text for ${id}`,
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
