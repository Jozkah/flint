/**
 * Pure operations on the conversation-groups state. Every function returns a
 * new state and touches only the surface it is given, so one surface can never
 * overwrite another's groups. Positions are renumbered densely after each
 * change so persisted order never depends on array indexes alone.
 */
import {
  GROUP_SURFACES,
  GROUPS_SCHEMA_VERSION,
  MAX_GROUP_DEPTH,
  type ConversationGroup,
  type GroupFolderBinding,
  type GroupLayout,
  type GroupMembership,
  type GroupSurface,
  type GroupsState,
  type ItemFolderContext,
  type SurfaceGroups,
  type SurfaceLayout,
} from './types'

export type GroupErrorCode = 'nameEmpty' | 'notFound' | 'tooDeep' | 'intoItself'

/** Carries a code, not prose: the store turns it into the user's language. */
export class GroupError extends Error {
  constructor(readonly code: GroupErrorCode) {
    super(code)
  }
}

export const emptySurface = (): SurfaceGroups => ({ groups: [], memberships: {}, contexts: {} })

export const emptyGroupsState = (): GroupsState => ({
  version: GROUPS_SCHEMA_VERSION,
  surfaces: { home: emptySurface(), cowork: emptySurface(), rooms: emptySurface() },
})

/** Trimmed name; empty names are rejected, duplicates are allowed. */
export function normalizeGroupName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim()
  if (!trimmed) throw new GroupError('nameEmpty')
  return trimmed.slice(0, 120)
}

function withSurface(
  state: GroupsState,
  surface: GroupSurface,
  next: SurfaceGroups
): GroupsState {
  return { ...state, surfaces: { ...state.surfaces, [surface]: next } }
}

function renumberGroups(groups: ConversationGroup[]): ConversationGroup[] {
  return groups.map((g, i) => (g.position === i ? g : { ...g, position: i }))
}

function sortedGroups(s: SurfaceGroups): ConversationGroup[] {
  return [...s.groups].sort((a, b) => a.position - b.position)
}

function membersOf(s: SurfaceGroups, groupId: string): GroupMembership[] {
  return Object.values(s.memberships)
    .filter((m) => m.groupId === groupId)
    .sort((a, b) => a.position - b.position)
}

function requireGroup(s: SurfaceGroups, groupId: string): ConversationGroup {
  const g = s.groups.find((x) => x.id === groupId)
  if (!g) throw new GroupError('notFound')
  return g
}

/** Depth of a group: 1 for top-level. Walks parents; stops on a cycle. */
export function groupDepth(s: SurfaceGroups, groupId: string): number {
  const byId = new Map(s.groups.map((g) => [g.id, g]))
  const seen = new Set<string>()
  let depth = 0
  let cur = byId.get(groupId)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    depth++
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return depth
}

/** Ids of a group's descendants (not the group itself). */
export function descendantIds(s: SurfaceGroups, groupId: string): Set<string> {
  const out = new Set<string>()
  const queue = [groupId]
  while (queue.length) {
    const id = queue.pop() as string
    for (const g of s.groups) {
      if (g.parentId === id && !out.has(g.id) && g.id !== groupId) {
        out.add(g.id)
        queue.push(g.id)
      }
    }
  }
  return out
}

/** Height of the subtree under a group: 1 for a leaf. */
function subtreeHeight(s: SurfaceGroups, groupId: string, guard = 0): number {
  if (guard > MAX_GROUP_DEPTH + 1) return 1
  let best = 0
  for (const g of s.groups) {
    if (g.parentId === groupId && g.id !== groupId)
      best = Math.max(best, subtreeHeight(s, g.id, guard + 1))
  }
  return best + 1
}

export function createGroup(
  state: GroupsState,
  surface: GroupSurface,
  input: {
    id: string
    name: string
    now: number
    folderBindings?: GroupFolderBinding[]
    parentId?: string | null
  }
): GroupsState {
  const s = state.surfaces[surface]
  const parentId = input.parentId ?? null
  if (parentId !== null) {
    requireGroup(s, parentId)
    if (groupDepth(s, parentId) + 1 > MAX_GROUP_DEPTH)
      throw new GroupError('tooDeep')
  }
  const group: ConversationGroup = {
    id: input.id,
    surface,
    name: normalizeGroupName(input.name),
    parentId,
    position: s.groups.length,
    collapsed: false,
    folderBindings: dedupeBindings(input.folderBindings ?? []),
    createdAt: input.now,
    updatedAt: input.now,
  }
  return withSurface(state, surface, {
    ...s,
    groups: renumberGroups([...sortedGroups(s), group]),
  })
}

function patchGroup(
  state: GroupsState,
  surface: GroupSurface,
  groupId: string,
  patch: (g: ConversationGroup) => ConversationGroup
): GroupsState {
  const s = state.surfaces[surface]
  requireGroup(s, groupId)
  return withSurface(state, surface, {
    ...s,
    groups: s.groups.map((g) => (g.id === groupId ? patch(g) : g)),
  })
}

export function renameGroup(
  state: GroupsState,
  surface: GroupSurface,
  groupId: string,
  name: string,
  now: number
): GroupsState {
  const clean = normalizeGroupName(name)
  return patchGroup(state, surface, groupId, (g) => ({ ...g, name: clean, updatedAt: now }))
}

/**
 * Moves a group under another group, or to the top level (null). Refuses a
 * move into itself or its own descendant (a cycle) and one that would push
 * any group past MAX_GROUP_DEPTH. Members stay with their group.
 */
export function setGroupParent(
  state: GroupsState,
  surface: GroupSurface,
  groupId: string,
  parentId: string | null,
  now: number
): GroupsState {
  const s = state.surfaces[surface]
  const g = requireGroup(s, groupId)
  if (parentId !== null) {
    requireGroup(s, parentId)
    if (parentId === groupId || descendantIds(s, groupId).has(parentId))
      throw new GroupError('intoItself')
    if (groupDepth(s, parentId) + subtreeHeight(s, groupId) > MAX_GROUP_DEPTH)
      throw new GroupError('tooDeep')
  }
  if (g.parentId === parentId) return state
  return patchGroup(state, surface, groupId, (x) => ({ ...x, parentId, updatedAt: now }))
}

export function setGroupCollapsed(
  state: GroupsState,
  surface: GroupSurface,
  groupId: string,
  collapsed: boolean
): GroupsState {
  return patchGroup(state, surface, groupId, (g) =>
    g.collapsed === collapsed ? g : { ...g, collapsed }
  )
}

export function setGroupFolders(
  state: GroupsState,
  surface: GroupSurface,
  groupId: string,
  bindings: GroupFolderBinding[],
  now: number
): GroupsState {
  const clean = dedupeBindings(bindings)
  return patchGroup(state, surface, groupId, (g) => ({
    ...g,
    folderBindings: clean,
    updatedAt: now,
  }))
}

/** Keeps the first binding per canonical path (case-insensitive on Windows-style paths). */
export function dedupeBindings(bindings: GroupFolderBinding[]): GroupFolderBinding[] {
  const seen = new Set<string>()
  const out: GroupFolderBinding[] = []
  for (const b of bindings) {
    const key = canonicalKey(b.canonicalPath)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(b)
  }
  return out
}

/** Comparison key for a canonical path: separators and drive/UNC case folded. */
export function canonicalKey(path: string): string {
  let p = path.trim().replace(/\\/g, '/')
  if (p.startsWith('//?/UNC/')) p = '//' + p.slice(8)
  else if (p.startsWith('//?/')) p = p.slice(4)
  if (p.length > 1) p = p.replace(/\/+$/, '')
  const windowsLike = /^[a-zA-Z]:\//.test(p) || /^[a-zA-Z]:$/.test(p) || p.startsWith('//')
  return windowsLike ? p.toLowerCase() : p
}

export function reorderGroup(
  state: GroupsState,
  surface: GroupSurface,
  groupId: string,
  toIndex: number
): GroupsState {
  const s = state.surfaces[surface]
  const groups = sortedGroups(s)
  const from = groups.findIndex((g) => g.id === groupId)
  if (from < 0) throw new GroupError('notFound')
  const [moved] = groups.splice(from, 1)
  groups.splice(clamp(toIndex, 0, groups.length), 0, moved)
  return withSurface(state, surface, { ...s, groups: renumberGroups(groups) })
}

/**
 * Moves an item into a group at `toIndex`, or to Recents when `groupId` is
 * null. Enforces one group per item by construction (memberships are keyed by
 * item id). Only memberships of the source and target groups are rewritten.
 */
export function moveItem(
  state: GroupsState,
  surface: GroupSurface,
  itemId: string,
  groupId: string | null,
  toIndex = Number.MAX_SAFE_INTEGER
): GroupsState {
  const s = state.surfaces[surface]
  if (groupId !== null) requireGroup(s, groupId)
  const memberships = { ...s.memberships }
  const previous = memberships[itemId]
  delete memberships[itemId]

  const renumber = (gid: string, insert?: { at: number }) => {
    const list = Object.values(memberships)
      .filter((m) => m.groupId === gid)
      .sort((a, b) => a.position - b.position)
      .map((m) => m.itemId)
    if (insert) list.splice(clamp(insert.at, 0, list.length), 0, itemId)
    list.forEach((id, i) => {
      memberships[id] = { groupId: gid, itemId: id, position: i }
    })
  }

  if (previous && previous.groupId !== groupId) renumber(previous.groupId)
  if (groupId !== null) renumber(groupId, { at: toIndex })
  return withSurface(state, surface, { ...s, memberships })
}

/**
 * Deletes a group; its members move to Recents and its sub-groups move up to
 * its parent. Items are never deleted.
 */
export function deleteGroup(
  state: GroupsState,
  surface: GroupSurface,
  groupId: string
): GroupsState {
  const s = state.surfaces[surface]
  const doomed = requireGroup(s, groupId)
  const memberships = Object.fromEntries(
    Object.entries(s.memberships).filter(([, m]) => m.groupId !== groupId)
  )
  return withSurface(state, surface, {
    ...s,
    groups: renumberGroups(
      sortedGroups(s)
        .filter((g) => g.id !== groupId)
        .map((g) => (g.parentId === groupId ? { ...g, parentId: doomed.parentId } : g))
    ),
    memberships,
  })
}

/** Drops the membership of a deleted item. */
export function removeItem(
  state: GroupsState,
  surface: GroupSurface,
  itemId: string
): GroupsState {
  const s = state.surfaces[surface]
  if (!s.memberships[itemId] && !s.contexts[itemId]) return state
  const next = s.memberships[itemId] ? moveItem(state, surface, itemId, null) : state
  const ns = next.surfaces[surface]
  const contexts = { ...ns.contexts }
  delete contexts[itemId]
  return withSurface(next, surface, { ...ns, contexts })
}

/** Sets or clears (null) the folder context an item took from a group. */
export function setItemContext(
  state: GroupsState,
  surface: GroupSurface,
  itemId: string,
  context: ItemFolderContext | null
): GroupsState {
  const s = state.surfaces[surface]
  const contexts = { ...s.contexts }
  if (context) contexts[itemId] = { ...context, folders: dedupeBindings(context.folders) }
  else if (contexts[itemId]) delete contexts[itemId]
  else return state
  return withSurface(state, surface, { ...s, contexts })
}

/** Drops memberships whose item no longer exists. No-op when nothing is stale. */
export function pruneMissingItems(
  state: GroupsState,
  surface: GroupSurface,
  liveIds: ReadonlySet<string>
): GroupsState {
  const s = state.surfaces[surface]
  const stale = new Set(
    [...Object.keys(s.memberships), ...Object.keys(s.contexts)].filter((id) => !liveIds.has(id))
  )
  if (stale.size === 0) return state
  let next = state
  for (const id of stale) next = removeItem(next, surface, id)
  return next
}

export function groupOfItem(
  state: GroupsState,
  surface: GroupSurface,
  itemId: string
): ConversationGroup | undefined {
  const s = state.surfaces[surface]
  const m = s.memberships[itemId]
  return m ? s.groups.find((g) => g.id === m.groupId) : undefined
}

/**
 * Resolves the render layout. `items` arrive in recent-activity order and that
 * order is kept for Recents. Memberships pointing at a missing group, and
 * memberships for items not in `items`, are ignored: such items fall back to
 * Recents, and nothing is ever hidden.
 */
export function layoutSurface<T>(
  s: SurfaceGroups,
  items: readonly T[],
  idOf: (item: T) => string
): SurfaceLayout<T> {
  const groups = sortedGroups(s)
  const groupIds = new Set(groups.map((g) => g.id))
  const byId = new Map<string, T>()
  for (const item of items) byId.set(idOf(item), item)
  const recents: T[] = []
  for (const item of items) {
    const m = s.memberships[idOf(item)]
    if (!m || !groupIds.has(m.groupId)) recents.push(item)
  }
  const kids = new Map<string | null, ConversationGroup[]>()
  for (const g of groups) {
    // A missing or self parent shows the group at the top level.
    const parent = g.parentId && g.parentId !== g.id && groupIds.has(g.parentId) ? g.parentId : null
    const list = kids.get(parent) ?? []
    list.push(g)
    kids.set(parent, list)
  }
  const placed = new Set<string>()
  const build = (g: ConversationGroup): GroupLayout<T> => {
    placed.add(g.id)
    return {
      group: g,
      children: membersOf(s, g.id)
        .map((m) => byId.get(m.itemId))
        .filter((x): x is T => x !== undefined),
      subgroups: (kids.get(g.id) ?? []).filter((c) => !placed.has(c.id)).map(build),
    }
  }
  const top = (kids.get(null) ?? []).map(build)
  // A cycle with no top-level entry would otherwise vanish; surface it.
  for (const g of groups) if (!placed.has(g.id)) top.push(build(g))
  return { groups: top, recents }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

// ---------------------------------------------------------------------------
// Recovery: turn whatever was on disk into a valid state without ever hiding
// an item. Corrupt groups are dropped; their members fall back to Recents.
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function sanitizeBinding(v: unknown): GroupFolderBinding | null {
  if (!isObj(v) || typeof v.path !== 'string' || !v.path.trim()) return null
  const canonicalPath =
    typeof v.canonicalPath === 'string' && v.canonicalPath.trim() ? v.canonicalPath : v.path
  const displayName =
    typeof v.displayName === 'string' && v.displayName.trim()
      ? v.displayName
      : basename(canonicalPath)
  return {
    path: v.path,
    canonicalPath,
    displayName,
    ...(typeof v.available === 'boolean' ? { available: v.available } : {}),
  }
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export function sanitizeSurface(surface: GroupSurface, raw: unknown): SurfaceGroups {
  if (!isObj(raw)) return emptySurface()
  const seen = new Set<string>()
  const groups: ConversationGroup[] = []
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : []
  rawGroups.forEach((g, i) => {
    if (!isObj(g) || typeof g.id !== 'string' || !g.id || seen.has(g.id)) return
    seen.add(g.id)
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Untitled group'
    groups.push({
      id: g.id,
      surface,
      name,
      parentId: typeof g.parentId === 'string' && g.parentId ? g.parentId : null,
      position: typeof g.position === 'number' && Number.isFinite(g.position) ? g.position : i,
      collapsed: g.collapsed === true,
      folderBindings: dedupeBindings(
        (Array.isArray(g.folderBindings) ? g.folderBindings : [])
          .map(sanitizeBinding)
          .filter((b): b is GroupFolderBinding => b !== null)
      ),
      createdAt: typeof g.createdAt === 'number' ? g.createdAt : 0,
      updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : 0,
    })
  })
  // Drop parents that are missing, self-referencing, cyclic or too deep so a
  // damaged file can never hide a group.
  const ids = new Set(groups.map((g) => g.id))
  const byId = new Map(groups.map((g) => [g.id, g]))
  for (const g of groups) {
    if (g.parentId !== null && (!ids.has(g.parentId) || g.parentId === g.id)) g.parentId = null
  }
  for (const g of groups) {
    const chain = new Set<string>([g.id])
    let cur = g.parentId ? byId.get(g.parentId) : undefined
    let depth = 1
    while (cur) {
      if (chain.has(cur.id) || depth + 1 > MAX_GROUP_DEPTH) {
        g.parentId = null
        break
      }
      chain.add(cur.id)
      depth++
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  const ordered = renumberGroups(
    groups.sort((a, b) => a.position - b.position)
  )

  const memberships: Record<string, GroupMembership> = {}
  if (isObj(raw.memberships)) {
    for (const [itemId, m] of Object.entries(raw.memberships)) {
      if (!isObj(m) || typeof m.groupId !== 'string' || !seen.has(m.groupId)) continue
      memberships[itemId] = {
        groupId: m.groupId,
        itemId,
        position: typeof m.position === 'number' && Number.isFinite(m.position) ? m.position : 0,
      }
    }
  }
  const contexts: Record<string, ItemFolderContext> = {}
  if (isObj(raw.contexts)) {
    for (const [itemId, c] of Object.entries(raw.contexts)) {
      if (!isObj(c) || (c.mode !== 'inherit' && c.mode !== 'merge')) continue
      contexts[itemId] = {
        mode: c.mode,
        folders: dedupeBindings(
          (Array.isArray(c.folders) ? c.folders : [])
            .map(sanitizeBinding)
            .filter((b): b is GroupFolderBinding => b !== null)
        ),
        sourceGroupId: typeof c.sourceGroupId === 'string' ? c.sourceGroupId : '',
        updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
      }
    }
  }
  // Renumber each group's members densely.
  const next: SurfaceGroups = { groups: ordered, memberships: {}, contexts }
  for (const g of ordered) {
    Object.values(memberships)
      .filter((m) => m.groupId === g.id)
      .sort((a, b) => a.position - b.position || a.itemId.localeCompare(b.itemId))
      .forEach((m, i) => {
        next.memberships[m.itemId] = { ...m, position: i }
      })
  }
  return next
}

/** Parses any persisted value into a valid current-version state. */
export function sanitizeGroupsState(raw: unknown): GroupsState {
  const state = emptyGroupsState()
  if (!isObj(raw) || !isObj(raw.surfaces)) return state
  const surfaces = raw.surfaces
  for (const surface of GROUP_SURFACES) {
    state.surfaces[surface] = sanitizeSurface(surface, surfaces[surface])
  }
  return state
}
