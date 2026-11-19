/**
 * Reads of the Chat (Home) <-> Cowork group link. The link is stored on the
 * Cowork group only (`linkedGroupId`); everything here derives the other
 * direction, so the two surfaces never share a write.
 */
import type { ConversationGroup, GroupsState } from './types'

/**
 * The Home group a Cowork group is linked to: its own link, else the nearest
 * linked ancestor's. A link to a Home group that no longer exists is ignored.
 */
export function linkedHomeGroup(
  state: GroupsState,
  coworkGroup: ConversationGroup | undefined
): ConversationGroup | undefined {
  const cowork = state.surfaces.cowork
  const seen = new Set<string>()
  let cur = coworkGroup
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.linkedGroupId) {
      const home = state.surfaces.home.groups.find((g) => g.id === cur!.linkedGroupId)
      if (home) return home
    }
    cur = cur.parentId ? cowork.groups.find((g) => g.id === cur!.parentId) : undefined
  }
  return undefined
}

/** The Home group a Cowork session's group links to, if any. */
export function linkedHomeGroupOfSession(
  state: GroupsState,
  sessionId: string | undefined
): ConversationGroup | undefined {
  if (!sessionId) return undefined
  const cowork = state.surfaces.cowork
  const m = cowork.memberships[sessionId]
  const group = m ? cowork.groups.find((g) => g.id === m.groupId) : undefined
  return linkedHomeGroup(state, group)
}

/** Cowork groups (direct links only) pointing at a Home group. */
export function coworkGroupsLinkedTo(state: GroupsState, homeGroupId: string): ConversationGroup[] {
  return state.surfaces.cowork.groups.filter((g) => g.linkedGroupId === homeGroupId)
}

/** Ids of items in a group of `surface` or any group below it. */
export function itemIdsInGroupTree(
  state: GroupsState,
  surface: 'home' | 'cowork',
  groupId: string
): string[] {
  const cowork = state.surfaces[surface]
  const ids = new Set([groupId])
  let grew = true
  while (grew) {
    grew = false
    for (const g of cowork.groups) {
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id)
        grew = true
      }
    }
  }
  return Object.values(cowork.memberships)
    .filter((m) => ids.has(m.groupId))
    .map((m) => m.itemId)
}
