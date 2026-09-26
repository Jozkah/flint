import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { configureGroups, useConversationGroups } from '../store'
import { emptyGroupsState } from '../domain'
import {
  addNewItemToGroup,
  inheritedFolders,
  missingFolders,
  moveWithFolders,
  type FolderAdapter,
} from '../inherit'
import type { GroupsPort } from '../persistence'
import type { GroupSurface } from '../types'

class MemoryPort implements GroupsPort {
  disk = new Map<GroupSurface, string>()
  async load(s: GroupSurface) {
    return this.disk.get(s) ?? null
  }
  async save(s: GroupSurface, raw: string) {
    this.disk.set(s, raw)
  }
}

/** An in-memory item surface: each item's attached folders. */
function memoryAdapter(initial: Record<string, string[]> = {}) {
  const folders: Record<string, string[]> = { ...initial }
  const adapter: FolderAdapter = {
    attached: async (id) => folders[id] ?? [],
    attach: async (id, paths) => {
      folders[id] = [...(folders[id] ?? []), ...paths]
      return paths
    },
    detach: async (id, paths) => {
      folders[id] = (folders[id] ?? []).filter((p) => !paths.includes(p))
    },
  }
  return { adapter, folders }
}

const store = () => useConversationGroups.getState()
const binding = (path: string) => ({
  path,
  canonicalPath: path,
  displayName: path.split('/').pop()!,
})

let n = 0
beforeEach(() => {
  n = 0
  configureGroups({
    port: new MemoryPort(),
    emit: () => {},
    now: () => 1000,
    newId: () => `g${n++}`,
  })
  useConversationGroups.setState({
    state: emptyGroupsState(),
    loaded: { home: true, cowork: true, rooms: true },
    migratedProjects: false,
  })
})

describe('group folder inheritance', () => {
  it('lists only folders not already attached, ignoring case and slashes', () => {
    expect(missingFolders(['C:\\Repo\\A'], ['c:/repo/a', 'C:/Repo/B', 'C:/Repo/B'])).toEqual([
      'C:/Repo/B',
    ])
  })

  it('a session created in a group gets its folders', async () => {
    const g = (await store().createGroup('cowork', 'Work', {
      folderBindings: [binding('/p/api'), binding('/p/web')],
    }))!
    const { adapter, folders } = memoryAdapter()
    await addNewItemToGroup('cowork', 's1', g, adapter)
    expect(store().state.surfaces.cowork.memberships.s1?.groupId).toBe(g)
    expect(folders.s1).toEqual(['/p/api', '/p/web'])
    expect(store().state.surfaces.cowork.contexts.s1?.folders.map((f) => f.path)).toEqual([
      '/p/api',
      '/p/web',
    ])
  })

  it('moving in adds only the missing folders and records just those', async () => {
    const g = (await store().createGroup('rooms', 'R', {
      folderBindings: [binding('/p/api'), binding('/p/web')],
    }))!
    const { adapter, folders } = memoryAdapter({ r1: ['/p/api'] })
    await moveWithFolders('rooms', 'r1', g, adapter, async () => true)
    expect(folders.r1).toEqual(['/p/api', '/p/web'])
    expect(await inheritedFolders('rooms', 'r1', g, adapter)).toEqual(['/p/web'])
  })

  it('moving out asks, and detaches only what the group gave when told to', async () => {
    const g = (await store().createGroup('cowork', 'Work', {
      folderBindings: [binding('/p/web')],
    }))!
    const { adapter, folders } = memoryAdapter({ s1: ['/own'] })
    await moveWithFolders('cowork', 's1', g, adapter, async () => true)
    const ask = vi.fn(async () => false)
    await moveWithFolders('cowork', 's1', null, adapter, ask)
    expect(ask).toHaveBeenCalledWith(['/p/web'])
    expect(folders.s1).toEqual(['/own'])
    expect(store().state.surfaces.cowork.memberships.s1).toBeUndefined()
    expect(store().state.surfaces.cowork.contexts.s1).toBeUndefined()
  })

  it('keeping the folders leaves them attached', async () => {
    const g = (await store().createGroup('cowork', 'Work', {
      folderBindings: [binding('/p/web')],
    }))!
    const { adapter, folders } = memoryAdapter()
    await moveWithFolders('cowork', 's1', g, adapter, async () => true)
    await moveWithFolders('cowork', 's1', null, adapter, async () => true)
    expect(folders.s1).toEqual(['/p/web'])
  })

  it('does not ask when the item inherited nothing', async () => {
    const g = (await store().createGroup('cowork', 'Empty'))!
    const { adapter } = memoryAdapter()
    await moveWithFolders('cowork', 's1', g, adapter, async () => true)
    const ask = vi.fn(async () => false)
    await moveWithFolders('cowork', 's1', null, adapter, ask)
    expect(ask).not.toHaveBeenCalled()
  })

  it('moving between groups swaps the folders', async () => {
    const a = (await store().createGroup('cowork', 'A', { folderBindings: [binding('/a')] }))!
    const b = (await store().createGroup('cowork', 'B', { folderBindings: [binding('/b')] }))!
    const { adapter, folders } = memoryAdapter()
    await moveWithFolders('cowork', 's1', a, adapter, async () => true)
    await moveWithFolders('cowork', 's1', b, adapter, async () => false)
    expect(folders.s1).toEqual(['/b'])
    expect(store().state.surfaces.cowork.contexts.s1?.sourceGroupId).toBe(b)
  })
})
