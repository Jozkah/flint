import { createContext, useContext } from 'react'
import type { ConversationGroup, GroupSurface } from '@/lib/groups/types'

/**
 * What a surface's row needs from the grouped list around it: the non-drag
 * "Move to group" commands, routed through the same permission flow as a drop.
 */
export type GroupedNavApi = {
  surface: GroupSurface
  groups: ConversationGroup[]
  groupIdOf: (itemId: string) => string | null
  /** Moves an item; resolves false when cancelled, refused or failed. */
  requestMove: (itemId: string, groupId: string | null, toIndex?: number) => Promise<boolean>
  /** Starts creating a group that the item moves into once named. */
  createGroupWith: (itemId: string) => void
}

export const GroupedNavContext = createContext<GroupedNavApi | null>(null)

export const useGroupedNav = () => useContext(GroupedNavContext)
