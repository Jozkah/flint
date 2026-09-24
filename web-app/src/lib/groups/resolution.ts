/**
 * Folder/permission resolution when an item joins a group.
 *
 * The plan only ever changes two things: the item's folder *context* (stored in
 * the groups store) and the group's folder list. It has no field for grants,
 * access modes or an item's attached folder, so no choice here can broaden
 * filesystem access. Access to a context folder still goes through the normal
 * approval, sandbox, canonicalization, protected-path and audit systems when
 * the item later uses it.
 */
import { dedupeBindings } from './domain'
import { foldersMissingFrom } from './folders'
import type { ConversationGroup, GroupFolderBinding, ItemFolderContext } from './types'

export type FolderChoice = 'keep' | 'inherit' | 'merge' | 'addToGroup' | 'cancel'

export type ItemFolderState = {
  /** Folders the item already works in (attached folder); read-only here. */
  own: GroupFolderBinding[]
  /** Context previously taken from a group, if any. */
  context?: ItemFolderContext
}

export type ResolutionPlan =
  | { cancelled: true }
  | {
      cancelled: false
      /** `undefined` leaves the context unchanged. */
      context?: ItemFolderContext
      /** `undefined` leaves the group's folders unchanged. */
      groupFolders?: GroupFolderBinding[]
    }

/** The folders the item currently treats as its context. */
export function effectiveFolders(item: ItemFolderState): GroupFolderBinding[] {
  if (!item.context) return item.own
  return item.context.mode === 'inherit'
    ? item.context.folders
    : dedupeBindings([...item.own, ...item.context.folders])
}

/** True when joining `group` should ask the user how to reconcile folders. */
export function needsResolution(item: ItemFolderState, group: ConversationGroup | null): boolean {
  if (!group) return false
  const mine = effectiveFolders(item)
  return (
    foldersMissingFrom(group.folderBindings, mine).length > 0 ||
    foldersMissingFrom(mine, group.folderBindings).length > 0
  )
}

export function planResolution(
  choice: FolderChoice,
  item: ItemFolderState,
  group: ConversationGroup,
  now: number
): ResolutionPlan {
  switch (choice) {
    case 'cancel':
      return { cancelled: true }
    case 'keep':
      return { cancelled: false }
    case 'inherit':
      return {
        cancelled: false,
        context: { mode: 'inherit', folders: [...group.folderBindings], sourceGroupId: group.id, updatedAt: now },
      }
    case 'merge':
      return {
        cancelled: false,
        context: {
          mode: 'merge',
          folders: dedupeBindings([...(item.context?.folders ?? []), ...group.folderBindings]),
          sourceGroupId: group.id,
          updatedAt: now,
        },
      }
    case 'addToGroup':
      return {
        cancelled: false,
        groupFolders: dedupeBindings([...group.folderBindings, ...foldersMissingFrom(effectiveFolders(item), group.folderBindings)]),
      }
  }
}
