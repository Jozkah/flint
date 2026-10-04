import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_SUBAGENT_SETTINGS,
  PERMISSION_NOTE,
  assistantBlock,
  profileBlock,
  resolveSubagentChoice,
  type SubagentSettings,
} from '../subagentSettings'
import { useSubagentSettings, currentSubagentSettings } from '@/hooks/useSubagentSettings'

const parent = { assistantId: 'parent-a', workProfile: 'plan' as const, model: { provider: 'p', id: 'parent-m' } }
const settings = (over: Partial<SubagentSettings> = {}): SubagentSettings => ({
  ...DEFAULT_SUBAGENT_SETTINGS,
  ...over,
})

describe('resolveSubagentChoice precedence', () => {
  it('inherits the parent when nothing is set', () => {
    const c = resolveSubagentChoice({ settings: settings(), role: 'explorer', parent })
    expect(c.assistantId).toEqual({ value: 'parent-a', source: 'parent' })
    expect(c.workProfile).toEqual({ value: 'plan', source: 'parent' })
    expect(c.model).toEqual({ value: parent.model, source: 'parent' })
  })

  it('the global setting beats the parent', () => {
    const c = resolveSubagentChoice({
      settings: settings({ global: { assistantId: 'g', model: { provider: 'p', id: 'cheap' } } }),
      role: 'explorer',
      parent,
    })
    expect(c.assistantId).toEqual({ value: 'g', source: 'global' })
    expect(c.model.value).toEqual({ provider: 'p', id: 'cheap' })
    expect(c.workProfile.source).toBe('parent')
  })

  it("a role's setting beats the global one, field by field", () => {
    const c = resolveSubagentChoice({
      settings: settings({
        global: { assistantId: 'g', workProfile: 'explain' },
        roles: { explorer: { workProfile: 'review' } },
      }),
      role: 'explorer',
      parent,
    })
    expect(c.workProfile).toEqual({ value: 'review', source: 'role' })
    expect(c.assistantId).toEqual({ value: 'g', source: 'global' })
    // Another role does not see explorer's setting.
    const other = resolveSubagentChoice({
      settings: settings({ roles: { explorer: { workProfile: 'review' } } }),
      role: 'tester',
      parent,
    })
    expect(other.workProfile.source).toBe('parent')
  })

  it('an explicit tool argument beats everything when the model may choose', () => {
    const c = resolveSubagentChoice({
      settings: settings({
        global: { model: { provider: 'p', id: 'g' } },
        roles: { explorer: { model: { provider: 'p', id: 'r' } } },
      }),
      role: 'explorer',
      requested: { model: { provider: 'p', id: 'asked' } },
      parent,
    })
    expect(c.model).toEqual({ value: { provider: 'p', id: 'asked' }, source: 'tool' })
  })

  it('with "Let the model choose" off, settings always win and the argument is ignored', () => {
    const c = resolveSubagentChoice({
      settings: settings({ letModelChoose: false, global: { model: { provider: 'p', id: 'g' } } }),
      role: 'explorer',
      requested: { model: { provider: 'p', id: 'asked' } },
      parent,
    })
    expect(c.model.value).toEqual({ provider: 'p', id: 'g' })
    expect(c.model.source).toBe('global')
    // With no setting either, the ignored argument falls through to the parent.
    const none = resolveSubagentChoice({
      settings: settings({ letModelChoose: false }),
      role: 'explorer',
      requested: { model: { provider: 'p', id: 'asked' } },
      parent,
    })
    expect(none.model.source).toBe('parent')
  })

  it('has no tool or permission field to set, so it cannot widen anything', () => {
    const c = resolveSubagentChoice({ settings: settings(), role: 'explorer', parent })
    expect(Object.keys(c).sort()).toEqual(['assistantId', 'model', 'workProfile'])
  })
})

describe('prompt blocks', () => {
  it('say they do not change tools or approvals', () => {
    expect(assistantBlock('Be terse.')).toContain(PERMISSION_NOTE)
    expect(profileBlock('# Review\n\n- read')).toContain(PERMISSION_NOTE)
    expect(assistantBlock('  ')).toBeUndefined()
    expect(profileBlock(undefined)).toBeUndefined()
  })
})

describe('useSubagentSettings', () => {
  beforeEach(() => useSubagentSettings.getState().reset())

  it('defaults to inheriting with the model allowed to choose', () => {
    expect(currentSubagentSettings()).toEqual(DEFAULT_SUBAGENT_SETTINGS)
  })

  it('sets and clears a field, and drops a role that ends up empty', () => {
    const s = useSubagentSettings.getState()
    s.setGlobal('workProfile', 'review')
    s.setRole('explorer', 'model', { provider: 'p', id: 'm' })
    expect(currentSubagentSettings().global.workProfile).toBe('review')
    expect(currentSubagentSettings().roles.explorer?.model?.id).toBe('m')
    useSubagentSettings.getState().setRole('explorer', 'model', undefined)
    expect(currentSubagentSettings().roles).toEqual({})
    useSubagentSettings.getState().setGlobal('workProfile', undefined)
    expect(currentSubagentSettings().global).toEqual({})
  })

  it('persists only the settings, not the actions', () => {
    useSubagentSettings.getState().setLetModelChoose(false)
    const stored = JSON.stringify(
      useSubagentSettings.persist.getOptions().partialize?.(useSubagentSettings.getState())
    )
    expect(JSON.parse(stored)).toEqual({ letModelChoose: false, global: {}, roles: {} })
  })
})
