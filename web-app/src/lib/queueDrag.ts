import type { DragEndEvent } from '@dnd-kit/core'

/**
 * Where a drop puts the dragged queued message: at the index of the one it
 * was dropped on. Null when nothing moves.
 */
export function queueDropTarget(
  event: Pick<DragEndEvent, 'active' | 'over'>
): { id: string; overId: string } | null {
  const { active, over } = event
  if (!over || active.id === over.id) return null
  return { id: String(active.id), overId: String(over.id) }
}
