/**
 * Drag-and-drop ids and the pure decision of what a drop means. Kept apart
 * from the component so every drop outcome is unit-testable without a pointer.
 */
export const GROUP_PREFIX = 'grp:'
export const ITEM_PREFIX = 'item:'
export const DROP_PREFIX = 'drop:'
export const RECENTS_DROP = `${DROP_PREFIX}recents`
export const groupDropId = (id: string) => `${DROP_PREFIX}${id}`

export function stripPrefix(id: string, prefix: string) {
  return id.startsWith(prefix) ? id.slice(prefix.length) : null
}

export type DropContext = {
  /** Group ids in display order. */
  groupOrder: readonly string[]
  /** Child item ids of a group, in display order. */
  childrenOf: (groupId: string) => readonly string[]
  /** The item's current group, or null for Recents. */
  groupIdOf: (itemId: string) => string | null
  /** Whether the id belongs to this surface's list. */
  hasItem: (itemId: string) => boolean
}

export type DropPlan =
  | { kind: 'reorderGroup'; groupId: string; toIndex: number }
  | { kind: 'moveItem'; itemId: string; groupId: string | null; toIndex?: number }
  | null

/** Group (or null for Recents) that a hovered id stands for; undefined when none. */
export function groupOfOver(over: string, ctx: DropContext): string | null | undefined {
  if (over === RECENTS_DROP) return null
  const g = stripPrefix(over, GROUP_PREFIX) ?? stripPrefix(over, DROP_PREFIX)
  if (g) return ctx.groupOrder.includes(g) ? g : undefined
  const item = stripPrefix(over, ITEM_PREFIX)
  if (item && ctx.hasItem(item)) return ctx.groupIdOf(item)
  return undefined
}

export function planDrop(active: string, over: string | null, ctx: DropContext): DropPlan {
  if (!over || over === active) return null

  const draggedGroup = stripPrefix(active, GROUP_PREFIX)
  if (draggedGroup) {
    if (!ctx.groupOrder.includes(draggedGroup)) return null
    const target = groupOfOver(over, ctx)
    if (!target) return null
    const toIndex = ctx.groupOrder.indexOf(target)
    if (toIndex === ctx.groupOrder.indexOf(draggedGroup)) return null
    return { kind: 'reorderGroup', groupId: draggedGroup, toIndex }
  }

  const itemId = stripPrefix(active, ITEM_PREFIX)
  // An id this list does not own (another surface, a file, text) is refused.
  if (!itemId || !ctx.hasItem(itemId)) return null
  const target = groupOfOver(over, ctx)
  if (target === undefined) return null
  const overItem = stripPrefix(over, ITEM_PREFIX)
  let toIndex: number | undefined
  if (target && overItem) {
    // moveItem removes then inserts, which matches arrayMove(from, over).
    toIndex = ctx.childrenOf(target).indexOf(overItem)
    if (toIndex < 0) toIndex = undefined
  }
  const current = ctx.groupIdOf(itemId)
  if (target === current && toIndex === undefined) return null
  if (target === null && current === null) return null
  return { kind: 'moveItem', itemId, groupId: target, toIndex }
}
