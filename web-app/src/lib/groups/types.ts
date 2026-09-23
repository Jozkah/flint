/**
 * Conversation groups: flat, user-ordered sections for sidebar items.
 *
 * One subsystem serves three independent namespaces (surfaces). A Home chat,
 * a Cowork session and a Room never share a group. Group metadata is stored
 * apart from the items it organizes; membership is keyed by the item's own
 * stable id, never by a display name or array index.
 */

export const GROUP_SURFACES = ['home', 'cowork', 'rooms'] as const
export type GroupSurface = (typeof GROUP_SURFACES)[number]

/** Current on-disk schema version of the groups store. */
export const GROUPS_SCHEMA_VERSION = 1

/**
 * A folder a group points at. Organizational context only: a binding never
 * grants filesystem access. `canonicalPath` is the dedup key; `available`
 * reflects the last check and a false value keeps the binding, marked.
 */
export type GroupFolderBinding = {
  path: string
  canonicalPath: string
  displayName: string
  available?: boolean
}

export type ConversationGroup = {
  id: string
  surface: GroupSurface
  name: string
  /** Dense 0-based order within the surface. */
  position: number
  collapsed: boolean
  folderBindings: GroupFolderBinding[]
  createdAt: number
  updatedAt: number
}

export type GroupMembership = {
  groupId: string
  itemId: string
  /** Dense 0-based order within the group. */
  position: number
}

export type SurfaceGroups = {
  groups: ConversationGroup[]
  /** Keyed by item id: an item belongs to zero or one group. */
  memberships: Record<string, GroupMembership>
}

export type GroupsState = {
  version: number
  surfaces: Record<GroupSurface, SurfaceGroups>
}

/** A group with its resolved, ordered children for rendering. */
export type GroupLayout<T> = {
  group: ConversationGroup
  children: T[]
}

export type SurfaceLayout<T> = {
  groups: GroupLayout<T>[]
  /** Ungrouped items, in the caller's recent-activity order. */
  recents: T[]
}
