import type { Announcements } from '@dnd-kit/core'

type T = (key: string, options?: Record<string, unknown>) => string

type Labelled = { data?: { current?: { label?: unknown } | null } | null } | null

function labelOf(node: Labelled, fallback: string): string {
  const label = node?.data?.current?.label
  const text = typeof label === 'function' ? label() : label
  return typeof text === 'string' && text.trim() ? text.trim() : fallback
}

/**
 * What a screen reader hears while a row is dragged onto a group: the row's
 * and the group's names (put on the draggable's and droppable's `data.label`),
 * never dnd-kit's default "Draggable item item:abc… was dropped over
 * droppable area group:xyz".
 */
export function groupDragAnnouncements(t: T): Announcements {
  const item = (n: Labelled) => labelOf(n, t('common:dnd.anItem'))
  const group = (n: Labelled) => labelOf(n, t('common:dnd.aGroup'))
  return {
    onDragStart: ({ active }) => t('common:dnd.picked', { item: item(active) }),
    onDragOver: ({ active, over }) =>
      over
        ? t('common:dnd.over', { item: item(active), group: group(over) })
        : t('common:dnd.notOver', { item: item(active) }),
    onDragEnd: ({ active, over }) =>
      over
        ? t('common:dnd.dropped', { item: item(active), group: group(over) })
        : t('common:dnd.cancelled', { item: item(active) }),
    onDragCancel: ({ active }) => t('common:dnd.cancelled', { item: item(active) }),
  }
}
