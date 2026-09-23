import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { toast } from 'sonner'
import { configureGroups, handleGroupsChanged, useConversationGroups, WINDOW_ORIGIN } from '../store'
import { emptyGroupsState, layoutSurface } from '../domain'
import { migrateProjects } from '../migrateProjects'
import { lastAnnouncement } from '../announce'
import type { GroupsChangedPayload, GroupsPort } from '../persistence'
import type { GroupSurface } from '../types'

class MemoryPort implements GroupsPort {
  disk = new Map<GroupSurface, string>()
  writes: GroupSurface[] = []
  fail = false
  async load(s: GroupSurface) {
    return this.disk.get(s) ?? null
  }
  async save(s: GroupSurface, raw: string) {
    if (this.fail) throw new Error('disk full')
    this.writes.push(s)
    this.disk.set(s, raw)
  }
}

let port: MemoryPort
let events: GroupsChangedPayload[]
let n = 0
const store = () => useConversationGroups.getState()

beforeEach(() => {
  port = new MemoryPort()
  events = []
  n = 0
  configureGroups({ port, emit: (p) => void events.push(p), now: () => 1000, newId: () => `id${n++}` })
  useConversationGroups.setState({
    state: emptyGroupsState(),
    loaded: { home: true, cowork: true, rooms: true },
    migratedProjects: false,
  })
  vi.mocked(toast.error).mockClear()
})

async function restart() {
  useConversationGroups.setState({ state: emptyGroupsState(), loaded: { home: false, cowork: false, rooms: false } })
  await store().loadAll()
}

describe('persistence', () => {
  it('survives restart with group and child order', async () => {
    const a = (await store().createGroup('home', 'A'))!
    const b = (await store().createGroup('home', 'B'))!
    await store().moveItem('home', 't1', a)
    await store().moveItem('home', 't2', a, 0)
    await store().reorderGroup('home', b, 0)
    await store().setCollapsed('home', a, true)
    await restart()
    const l = layoutSurface(store().state.surfaces.home, [{ id: 't1' }, { id: 't2' }], (x) => x.id)
    expect(l.groups.map((g) => g.group.name)).toEqual(['B', 'A'])
    expect(l.groups[1].children.map((c) => c.id)).toEqual(['t2', 't1'])
    expect(l.groups[1].group.collapsed).toBe(true)
  })

  it('writes only the touched surface', async () => {
    await store().createGroup('cowork', 'C')
    await store().createGroup('rooms', 'R')
    expect(port.writes).toEqual(['cowork', 'rooms'])
    expect(port.disk.has('home')).toBe(false)
  })

  it('rolls back and reports when a write fails', async () => {
    const a = (await store().createGroup('home', 'A'))!
    await store().moveItem('home', 't1', a)
    const before = store().state.surfaces.home
    port.fail = true
    const ok = await store().moveItem('home', 't1', null)
    expect(ok).toBe(false)
    expect(store().state.surfaces.home).toBe(before)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('previous order was restored'))
    expect(lastAnnouncement()).toContain('previous order was restored')
  })

  it('recovers from corrupt storage without hiding items', async () => {
    port.disk.set('home', '{not json')
    port.disk.set('cowork', JSON.stringify({ version: 1, data: { groups: 'x', memberships: { s1: { groupId: 'gone' } } } }))
    await restart()
    expect(store().state.surfaces.home.groups).toEqual([])
    const l = layoutSurface(store().state.surfaces.cowork, [{ id: 's1' }], (x) => x.id)
    expect(l.recents.map((x) => x.id)).toEqual(['s1'])
  })

  it('rejects empty names without writing', async () => {
    expect(await store().createGroup('home', '  ')).toBeNull()
    expect(port.writes).toEqual([])
  })

  it('refuses cross-surface moves', async () => {
    const a = (await store().createGroup('home', 'A'))!
    expect(await store().moveItem('cowork', 's1', a)).toBe(false)
    expect(store().state.surfaces.cowork.memberships).toEqual({})
  })
})

describe('multi-window sync', () => {
  it('emits on write and reloads on foreign events only', async () => {
    await store().createGroup('rooms', 'R')
    expect(events).toEqual([{ surface: 'rooms', origin: WINDOW_ORIGIN }])
    // Another window wrote a different rooms state to disk.
    port.disk.set('rooms', JSON.stringify({ version: 1, data: { groups: [{ id: 'x', name: 'Other' }], memberships: {} } }))
    handleGroupsChanged({ surface: 'rooms', origin: WINDOW_ORIGIN })
    await Promise.resolve()
    expect(store().state.surfaces.rooms.groups[0].name).toBe('R')
    handleGroupsChanged({ surface: 'rooms', origin: 'other-window' })
    await vi.waitFor(() => expect(store().state.surfaces.rooms.groups[0].name).toBe('Other'))
  })
})

describe('projects migration', () => {
  it('imports legacy projects with their threads', async () => {
    const data = migrateProjects(
      [{ id: 'p1', name: 'Alpha' }, { id: 'p1', name: 'dupe' }, { id: 'p2', name: '' }],
      [
        { id: 't1', updated: 1, metadata: { project: { id: 'p1' } } },
        { id: 't2', updated: 5, metadata: { project: { id: 'p1' } } },
        { id: 't3', metadata: { project: { id: 'missing' } } },
        { id: 't4' },
      ],
      7
    )
    await store().importSurface('home', data, true)
    await restart()
    expect(store().migratedProjects).toBe(true)
    const l = layoutSurface(store().state.surfaces.home, ['t1', 't2', 't3', 't4'].map((id) => ({ id })), (x) => x.id)
    expect(l.groups.map((g) => [g.group.id, g.group.name])).toEqual([['p1', 'Alpha'], ['p2', 'Untitled group']])
    expect(l.groups[0].children.map((c) => c.id)).toEqual(['t2', 't1'])
    expect(l.recents.map((c) => c.id)).toEqual(['t3', 't4'])
  })
})

describe('deletion', () => {
  it('deleting a group keeps items and announces the move to Recents', async () => {
    const a = (await store().createGroup('cowork', 'Work'))!
    await store().moveItem('cowork', 's1', a)
    await store().deleteGroup('cowork', a)
    expect(store().state.surfaces.cowork.memberships).toEqual({})
    expect(lastAnnouncement()).toBe('Group Work deleted. Its items moved to Recents')
  })

  it('prunes memberships of deleted items', async () => {
    const a = (await store().createGroup('rooms', 'R'))!
    await store().moveItem('rooms', 'r1', a)
    await store().moveItem('rooms', 'r2', a)
    await store().pruneMissing('rooms', new Set(['r2']))
    expect(Object.keys(store().state.surfaces.rooms.memberships)).toEqual(['r2'])
  })
})
