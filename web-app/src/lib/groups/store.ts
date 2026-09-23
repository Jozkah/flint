/**
 * The single conversation-groups store shared by Home, Cowork and Rooms.
 *
 * Updates are optimistic: the new state renders immediately, the surface is
 * written, and a failed write restores the exact previous surface snapshot and
 * reports a concise error. Only the touched surface is written. After a write,
 * other windows are told to reload that surface.
 */
import { create } from 'zustand'
import { ulid } from 'ulidx'
import { toast } from 'sonner'
import * as domain from './domain'
import {
  GROUPS_CHANGED_EVENT,
  decodeSurface,
  encodeSurface,
  settingsGroupsPort,
  type GroupsChangedPayload,
  type GroupsPort,
} from './persistence'
import { announce } from './announce'
import {
  GROUP_SURFACES,
  type GroupFolderBinding,
  type GroupSurface,
  type GroupsState,
  type SurfaceGroups,
} from './types'

/** Identifies this window so it ignores its own change events. */
const WINDOW_ORIGIN = ulid()

type Emit = (payload: GroupsChangedPayload) => Promise<void> | void

type Env = { port: GroupsPort; emit: Emit; now: () => number; newId: () => string }

let env: Env = {
  port: settingsGroupsPort,
  emit: () => {},
  now: () => Date.now(),
  newId: () => ulid(),
}

/** Test and bootstrap seam: swap storage, event emitter, clock or id source. */
export function configureGroups(next: Partial<Env>) {
  env = { ...env, ...next }
}

type GroupsStore = {
  state: GroupsState
  loaded: Record<GroupSurface, boolean>
  migratedProjects: boolean
  /** Items temporarily revealed by navigation, without persisting expansion. */
  revealed: Record<GroupSurface, string | null>

  load: (surface: GroupSurface) => Promise<void>
  loadAll: () => Promise<void>
  createGroup: (
    surface: GroupSurface,
    name: string,
    opts?: { id?: string; folderBindings?: GroupFolderBinding[] }
  ) => Promise<string | null>
  renameGroup: (surface: GroupSurface, groupId: string, name: string) => Promise<boolean>
  setCollapsed: (surface: GroupSurface, groupId: string, collapsed: boolean) => Promise<boolean>
  reorderGroup: (surface: GroupSurface, groupId: string, toIndex: number) => Promise<boolean>
  moveItem: (
    surface: GroupSurface,
    itemId: string,
    groupId: string | null,
    toIndex?: number
  ) => Promise<boolean>
  deleteGroup: (surface: GroupSurface, groupId: string) => Promise<boolean>
  setFolders: (
    surface: GroupSurface,
    groupId: string,
    bindings: GroupFolderBinding[]
  ) => Promise<boolean>
  removeItem: (surface: GroupSurface, itemId: string) => Promise<void>
  pruneMissing: (surface: GroupSurface, liveIds: ReadonlySet<string>) => Promise<void>
  /** Replaces a whole surface; used by the one-time projects migration. */
  importSurface: (surface: GroupSurface, data: SurfaceGroups, migratedProjects: boolean) => Promise<boolean>
  reveal: (surface: GroupSurface, itemId: string | null) => void
}

const allFalse = () => ({ home: false, cowork: false, rooms: false })

export const useConversationGroups = create<GroupsStore>()((set, get) => {
  /**
   * Applies `op` to one surface, persists, and rolls back on failure. The
   * rollback restores only this surface, and only if no later write replaced
   * it meanwhile, so a failed write cannot undo a newer successful one.
   */
  async function commit(
    surface: GroupSurface,
    op: (s: GroupsState) => GroupsState,
    failure: string
  ): Promise<boolean> {
    const before = get().state
    let next: GroupsState
    try {
      next = op(before)
    } catch (error) {
      const message = error instanceof domain.GroupError ? error.message : failure
      toast.error(message)
      announce(message)
      return false
    }
    if (next === before) return true
    set({ state: next })
    try {
      await env.port.save(
        surface,
        encodeSurface(next.surfaces[surface], surface === 'home' && get().migratedProjects)
      )
    } catch (error) {
      console.error(`Saving ${surface} groups failed:`, error)
      if (get().state.surfaces[surface] === next.surfaces[surface]) {
        set((s) => ({
          state: { ...s.state, surfaces: { ...s.state.surfaces, [surface]: before.surfaces[surface] } },
        }))
      }
      const message = `${failure}. Your previous order was restored.`
      toast.error(message)
      announce(message)
      return false
    }
    void Promise.resolve(env.emit({ surface, origin: WINDOW_ORIGIN })).catch(() => {})
    return true
  }

  return {
    state: domain.emptyGroupsState(),
    loaded: allFalse(),
    migratedProjects: false,
    revealed: { home: null, cowork: null, rooms: null },

    load: async (surface) => {
      let raw: string | null = null
      try {
        raw = await env.port.load(surface)
      } catch (error) {
        // Unreadable storage: show everything under Recents, never hide items.
        console.error(`Loading ${surface} groups failed:`, error)
      }
      const decoded = decodeSurface(raw)
      const data = domain.sanitizeSurface(surface, decoded?.data)
      set((s) => ({
        state: { ...s.state, surfaces: { ...s.state.surfaces, [surface]: data } },
        loaded: { ...s.loaded, [surface]: true },
        ...(surface === 'home' ? { migratedProjects: decoded?.migratedProjects ?? false } : {}),
      }))
    },

    loadAll: async () => {
      await Promise.all(GROUP_SURFACES.map((s) => get().load(s)))
    },

    createGroup: async (surface, name, opts) => {
      const id = opts?.id ?? env.newId()
      const ok = await commit(
        surface,
        (s) => domain.createGroup(s, surface, { id, name, now: env.now(), folderBindings: opts?.folderBindings }),
        'Could not create the group'
      )
      if (ok) announce(`Group ${name.trim()} created`)
      return ok ? id : null
    },

    renameGroup: (surface, groupId, name) =>
      commit(surface, (s) => domain.renameGroup(s, surface, groupId, name, env.now()), 'Could not rename the group'),

    setCollapsed: async (surface, groupId, collapsed) => {
      const ok = await commit(
        surface,
        (s) => domain.setGroupCollapsed(s, surface, groupId, collapsed),
        'Could not save the group state'
      )
      const name = get().state.surfaces[surface].groups.find((g) => g.id === groupId)?.name
      if (ok && name) announce(`${name} ${collapsed ? 'collapsed' : 'expanded'}`)
      return ok
    },

    reorderGroup: async (surface, groupId, toIndex) => {
      const ok = await commit(
        surface,
        (s) => domain.reorderGroup(s, surface, groupId, toIndex),
        'Could not reorder groups'
      )
      const groups = get().state.surfaces[surface].groups
      const g = groups.find((x) => x.id === groupId)
      if (ok && g) announce(`${g.name} moved to position ${g.position + 1} of ${groups.length}`)
      return ok
    },

    moveItem: async (surface, itemId, groupId, toIndex) => {
      const ok = await commit(
        surface,
        (s) => domain.moveItem(s, surface, itemId, groupId, toIndex),
        'Could not move the item'
      )
      if (ok) {
        const s = get().state.surfaces[surface]
        const g = groupId ? s.groups.find((x) => x.id === groupId) : null
        const m = s.memberships[itemId]
        announce(g && m ? `Moved to ${g.name}, position ${m.position + 1}` : 'Moved to Recents')
      }
      return ok
    },

    deleteGroup: async (surface, groupId) => {
      const name = get().state.surfaces[surface].groups.find((g) => g.id === groupId)?.name
      const ok = await commit(surface, (s) => domain.deleteGroup(s, surface, groupId), 'Could not delete the group')
      if (ok && name) announce(`Group ${name} deleted. Its items moved to Recents`)
      return ok
    },

    setFolders: (surface, groupId, bindings) =>
      commit(
        surface,
        (s) => domain.setGroupFolders(s, surface, groupId, bindings, env.now()),
        'Could not save group folders'
      ),

    removeItem: async (surface, itemId) => {
      await commit(surface, (s) => domain.removeItem(s, surface, itemId), 'Could not update groups')
    },

    pruneMissing: async (surface, liveIds) => {
      if (!get().loaded[surface]) return
      await commit(surface, (s) => domain.pruneMissingItems(s, surface, liveIds), 'Could not update groups')
    },

    importSurface: async (surface, data, migratedProjects) => {
      if (surface === 'home') set({ migratedProjects })
      return commit(
        surface,
        (s) => ({
          ...s,
          surfaces: { ...s.surfaces, [surface]: domain.sanitizeSurface(surface, data) },
        }),
        'Could not import groups'
      )
    },

    reveal: (surface, itemId) => set((s) => ({ revealed: { ...s.revealed, [surface]: itemId } })),
  }
})

/** Handles another window's change event: reload that surface from disk. */
export function handleGroupsChanged(payload: GroupsChangedPayload | undefined) {
  if (!payload || payload.origin === WINDOW_ORIGIN) return
  if (!GROUP_SURFACES.includes(payload.surface)) return
  void useConversationGroups.getState().load(payload.surface)
}

export { GROUPS_CHANGED_EVENT, WINDOW_ORIGIN }
