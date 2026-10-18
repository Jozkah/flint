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
import i18n from '@/i18n/setup'
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

const t = (key: string, vars?: Record<string, unknown>) => i18n.t(`common:groups.${key}`, vars)
import {
  GROUP_SURFACES,
  type GroupFolderBinding,
  type GroupSurface,
  type GroupsState,
  type ItemFolderContext,
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
  /**
   * Surfaces whose stored groups could not be read. They show as empty, but
   * nothing is saved over them (or migrated into them) until a read succeeds.
   */
  unreadable: Record<GroupSurface, boolean>
  migratedProjects: boolean

  load: (surface: GroupSurface) => Promise<void>
  loadAll: () => Promise<void>
  createGroup: (
    surface: GroupSurface,
    name: string,
    opts?: { id?: string; folderBindings?: GroupFolderBinding[]; parentId?: string | null }
  ) => Promise<string | null>
  renameGroup: (surface: GroupSurface, groupId: string, name: string) => Promise<boolean>
  /** Nests a group under another (or null for top level); false when refused. */
  setGroupParent: (surface: GroupSurface, groupId: string, parentId: string | null) => Promise<boolean>
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
  /**
   * Moves an item and applies a folder-resolution plan in one write: the
   * membership, the item's folder context and the group's folders either all
   * persist or all roll back.
   */
  moveWithPlan: (
    surface: GroupSurface,
    itemId: string,
    groupId: string | null,
    toIndex: number | undefined,
    plan: { context?: ItemFolderContext; groupFolders?: GroupFolderBinding[] }
  ) => Promise<boolean>
  /** Sets or clears (null) the folder context an item took from a group. */
  setItemContext: (
    surface: GroupSurface,
    itemId: string,
    context: ItemFolderContext | null
  ) => Promise<boolean>
  removeItem: (surface: GroupSurface, itemId: string) => Promise<void>
  pruneMissing: (surface: GroupSurface, liveIds: ReadonlySet<string>) => Promise<void>
  /** Replaces a whole surface; used by the one-time projects migration. */
  importSurface: (surface: GroupSurface, data: SurfaceGroups, migratedProjects: boolean) => Promise<boolean>
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
    if (get().unreadable?.[surface]) {
      const message = t('failed.unreadable', { failure })
      toast.error(message)
      announce(message)
      return false
    }
    const before = get().state
    let next: GroupsState
    try {
      next = op(before)
    } catch (error) {
      const message = error instanceof domain.GroupError ? t(`errors.${error.code}`) : failure
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
      const message = t('failed.restored', { failure })
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
    unreadable: allFalse(),
    migratedProjects: false,

    load: async (surface) => {
      let raw: string | null = null
      let unreadable = false
      try {
        raw = await env.port.load(surface)
      } catch (error) {
        // Unreadable storage: show everything under Recents, never hide items.
        console.error(`Loading ${surface} groups failed:`, error)
        unreadable = true
      }
      const decoded = decodeSurface(raw)
      const data = domain.sanitizeSurface(surface, decoded?.data)
      set((s) => ({
        state: { ...s.state, surfaces: { ...s.state.surfaces, [surface]: data } },
        loaded: { ...s.loaded, [surface]: true },
        unreadable: { ...s.unreadable, [surface]: unreadable },
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
        (s) => domain.createGroup(s, surface, { id, name, now: env.now(), folderBindings: opts?.folderBindings, parentId: opts?.parentId }),
        t('failed.create')
      )
      if (ok) announce(t('announce.created', { name: name.trim() }))
      return ok ? id : null
    },

    renameGroup: (surface, groupId, name) =>
      commit(surface, (s) => domain.renameGroup(s, surface, groupId, name, env.now()), t('failed.rename')),

    setGroupParent: (surface, groupId, parentId) =>
      commit(
        surface,
        (s) => domain.setGroupParent(s, surface, groupId, parentId, env.now()),
        t('failed.moveFolder')
      ),

    setCollapsed: async (surface, groupId, collapsed) => {
      const ok = await commit(
        surface,
        (s) => domain.setGroupCollapsed(s, surface, groupId, collapsed),
        t('failed.saveState')
      )
      const name = get().state.surfaces[surface].groups.find((g) => g.id === groupId)?.name
      if (ok && name) announce(t(collapsed ? 'announce.collapsed' : 'announce.expanded', { name }))
      return ok
    },

    reorderGroup: async (surface, groupId, toIndex) => {
      const ok = await commit(
        surface,
        (s) => domain.reorderGroup(s, surface, groupId, toIndex),
        t('failed.reorder')
      )
      const groups = get().state.surfaces[surface].groups
      const g = groups.find((x) => x.id === groupId)
      if (ok && g) announce(t('announce.reordered', { name: g.name, position: g.position + 1, total: groups.length }))
      return ok
    },

    moveItem: async (surface, itemId, groupId, toIndex) => {
      const ok = await commit(
        surface,
        (s) => domain.moveItem(s, surface, itemId, groupId, toIndex),
        t('failed.moveItem')
      )
      if (ok) {
        const s = get().state.surfaces[surface]
        const g = groupId ? s.groups.find((x) => x.id === groupId) : null
        const m = s.memberships[itemId]
        announce(g && m ? t('announce.movedToPosition', { name: g.name, position: m.position + 1 }) : t('announce.movedToRecents'))
      }
      return ok
    },

    deleteGroup: async (surface, groupId) => {
      const name = get().state.surfaces[surface].groups.find((g) => g.id === groupId)?.name
      const ok = await commit(surface, (s) => domain.deleteGroup(s, surface, groupId), t('failed.delete'))
      if (ok && name) announce(t('announce.deleted', { name }))
      return ok
    },

    setFolders: (surface, groupId, bindings) =>
      commit(
        surface,
        (s) => domain.setGroupFolders(s, surface, groupId, bindings, env.now()),
        t('failed.saveFolders')
      ),

    moveWithPlan: async (surface, itemId, groupId, toIndex, plan) => {
      const ok = await commit(
        surface,
        (s) => {
          let next = domain.moveItem(s, surface, itemId, groupId, toIndex)
          if (plan.context) next = domain.setItemContext(next, surface, itemId, plan.context)
          if (plan.groupFolders && groupId)
            next = domain.setGroupFolders(next, surface, groupId, plan.groupFolders, env.now())
          return next
        },
        t('failed.moveItem')
      )
      if (ok) {
        const s = get().state.surfaces[surface]
        const g = groupId ? s.groups.find((x) => x.id === groupId) : null
        const base = g ? t('movedTo', { name: g.name }) : t('announce.movedToRecents')
        const key = plan.context
          ? plan.context.mode === 'inherit'
            ? 'announce.ctxReplaced'
            : 'announce.ctxMerged'
          : plan.groupFolders
            ? 'announce.foldersAdded'
            : null
        announce(key ? t(key, { base }) : base)
      }
      return ok
    },

    setItemContext: (surface, itemId, context) =>
      commit(
        surface,
        (s) => domain.setItemContext(s, surface, itemId, context),
        t('failed.updateContext')
      ),

    removeItem: async (surface, itemId) => {
      await commit(surface, (s) => domain.removeItem(s, surface, itemId), t('failed.update'))
    },

    pruneMissing: async (surface, liveIds) => {
      if (!get().loaded[surface]) return
      await commit(surface, (s) => domain.pruneMissingItems(s, surface, liveIds), t('failed.update'))
    },

    importSurface: async (surface, data, migratedProjects) => {
      const previous = get().migratedProjects
      if (surface === 'home') set({ migratedProjects })
      const ok = await commit(
        surface,
        (s) => ({
          ...s,
          surfaces: { ...s.surfaces, [surface]: domain.sanitizeSurface(surface, data) },
        }),
        t('failed.import')
      )
      // The flag only sticks once it is on disk, so a failed import is retried.
      if (!ok && surface === 'home') set({ migratedProjects: previous })
      return ok
    },

  }
})

/** Handles another window's change event: reload that surface from disk. */
export function handleGroupsChanged(payload: GroupsChangedPayload | undefined) {
  if (!payload || payload.origin === WINDOW_ORIGIN) return
  if (!GROUP_SURFACES.includes(payload.surface)) return
  void useConversationGroups.getState().load(payload.surface)
}

export { GROUPS_CHANGED_EVENT, WINDOW_ORIGIN }
