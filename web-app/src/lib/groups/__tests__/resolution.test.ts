import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { effectiveFolders, needsResolution, planResolution, type FolderChoice } from '../resolution'
import { configureGroups, useConversationGroups } from '../store'
import { emptyGroupsState } from '../domain'
import type { ConversationGroup, GroupFolderBinding, GroupSurface } from '../types'
import type { GroupsPort } from '../persistence'

const f = (p: string, available?: boolean): GroupFolderBinding => ({
  path: p,
  canonicalPath: p,
  displayName: p.split('/').pop()!,
  ...(available === undefined ? {} : { available }),
})

const group = (folders: GroupFolderBinding[]): ConversationGroup => ({
  id: 'g',
  surface: 'cowork',
  name: 'G',
  position: 0,
  collapsed: false,
  folderBindings: folders,
  createdAt: 0,
  updatedAt: 0,
})

const item = { own: [f('/repo/app')] }
const g = group([f('/repo/docs'), f('/repo/app')])

describe('needsResolution', () => {
  it('only asks when folders differ', () => {
    expect(needsResolution(item, group([f('/repo/app')]))).toBe(false)
    expect(needsResolution(item, g)).toBe(true)
    expect(needsResolution({ own: [] }, group([]))).toBe(false)
    expect(needsResolution(item, null)).toBe(false)
  })
})

describe('planResolution', () => {
  it('keep changes nothing but membership', () => {
    expect(planResolution('keep', item, g, 1)).toEqual({ cancelled: false })
  })
  it('cancel changes nothing', () => {
    expect(planResolution('cancel', item, g, 1)).toEqual({ cancelled: true })
  })
  it('inherit replaces folder context with group folders', () => {
    const p = planResolution('inherit', item, g, 1)
    expect(p).toMatchObject({ cancelled: false, context: { mode: 'inherit', sourceGroupId: 'g' } })
    if (!p.cancelled) expect(effectiveFolders({ ...item, context: p.context })).toEqual(g.folderBindings)
  })
  it('merge keeps item folders and adds group folders', () => {
    const p = planResolution('merge', item, g, 1)
    if (p.cancelled) throw new Error('unexpected')
    expect(effectiveFolders({ ...item, context: p.context }).map((x) => x.path)).toEqual(['/repo/app', '/repo/docs'])
  })
  it('addToGroup adds only missing item folders to the group', () => {
    const p = planResolution('addToGroup', { own: [f('/repo/app'), f('/x')] }, g, 1)
    if (p.cancelled) throw new Error('unexpected')
    expect(p.context).toBeUndefined()
    expect(p.groupFolders!.map((x) => x.path)).toEqual(['/repo/docs', '/repo/app', '/x'])
  })
  it('keeps unavailable folders marked', () => {
    const p = planResolution('inherit', item, group([f('/gone', false)]), 1)
    if (p.cancelled) throw new Error('unexpected')
    expect(p.context!.folders[0].available).toBe(false)
  })
  it('no plan carries a grant, access mode or attached-folder field', () => {
    const allowed = new Set(['cancelled', 'context', 'groupFolders'])
    for (const c of ['keep', 'inherit', 'merge', 'addToGroup', 'cancel'] as FolderChoice[]) {
      for (const key of Object.keys(planResolution(c, item, g, 1))) expect(allowed.has(key)).toBe(true)
    }
  })
})

describe('moving never grants filesystem access', () => {
  const saved: string[] = []
  const port: GroupsPort = {
    load: async () => null,
    save: async (_s: GroupSurface, raw: string) => void saved.push(raw),
  }
  const invoke = vi.fn()

  beforeEach(() => {
    saved.length = 0
    invoke.mockClear()
    // Any backend call other than the port would show up here.
    ;(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke }
    configureGroups({ port, emit: () => {}, now: () => 5, newId: () => 'g' })
    useConversationGroups.setState({ state: emptyGroupsState(), loaded: { home: true, cowork: true, rooms: true } })
  })

  it.each(['keep', 'inherit', 'merge', 'addToGroup'] as const)('%s writes only group metadata', async (choice) => {
    await useConversationGroups.getState().createGroup('cowork', 'G', { folderBindings: g.folderBindings })
    const target = useConversationGroups.getState().state.surfaces.cowork.groups[0]
    const plan = planResolution(choice, item, target, 5)
    if (plan.cancelled) throw new Error('unexpected')
    expect(await useConversationGroups.getState().moveWithPlan('cowork', 's1', 'g', undefined, plan)).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    const last = JSON.parse(saved[saved.length - 1])
    expect(Object.keys(last.data).sort()).toEqual(['contexts', 'groups', 'memberships'])
    expect(JSON.stringify(last)).not.toMatch(/grant|access|consent|editConsent/i)
  })

  it('moving to Recents keeps folder context', async () => {
    await useConversationGroups.getState().createGroup('cowork', 'G', { folderBindings: g.folderBindings })
    const target = useConversationGroups.getState().state.surfaces.cowork.groups[0]
    const plan = planResolution('inherit', item, target, 5)
    if (plan.cancelled) throw new Error('unexpected')
    await useConversationGroups.getState().moveWithPlan('cowork', 's1', 'g', undefined, plan)
    await useConversationGroups.getState().moveItem('cowork', 's1', null)
    expect(useConversationGroups.getState().state.surfaces.cowork.contexts.s1.mode).toBe('inherit')
  })

  it('a failed write rolls back membership, context and group folders together', async () => {
    await useConversationGroups.getState().createGroup('cowork', 'G', { folderBindings: g.folderBindings })
    const before = useConversationGroups.getState().state.surfaces.cowork
    configureGroups({ port: { load: async () => null, save: async () => { throw new Error('x') } } })
    const plan = planResolution('addToGroup', { own: [f('/new')] }, before.groups[0], 5)
    if (plan.cancelled) throw new Error('unexpected')
    expect(await useConversationGroups.getState().moveWithPlan('cowork', 's1', 'g', undefined, plan)).toBe(false)
    expect(useConversationGroups.getState().state.surfaces.cowork).toBe(before)
  })
})
