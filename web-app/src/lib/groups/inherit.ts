/**
 * Folder inheritance for grouped Cowork sessions and Rooms.
 *
 * An item that joins a group (dragged in, or created from the group's "+")
 * gets the group's folders attached through the surface's own attach path,
 * so every existing safeguard applies: a Cowork session attached to a new
 * folder drops back to review-only access, and a room folder is read by the
 * room's tools under their usual permissions. The folders actually added are
 * recorded as the item's folder context, so leaving the group can offer to
 * detach exactly those and nothing the item had before.
 */
import { canonicalKey } from './domain'
import { folderBindingFor } from './folders'
import { useConversationGroups } from './store'
import type { GroupSurface } from './types'

/** How one surface attaches and detaches folders on its items. */
export type FolderAdapter = {
  /** Folders the item already has attached. */
  attached: (itemId: string) => Promise<string[]>
  /** Attach the folders it can; resolves to the ones it attached. */
  attach: (itemId: string, paths: string[]) => Promise<string[]>
  /** Detach these folders from the item. */
  detach: (itemId: string, paths: string[]) => Promise<void>
}

const groups = () => useConversationGroups.getState()

/** Folders of `paths` not already attached, compared by canonical key. */
export function missingFolders(attached: string[], paths: string[]): string[] {
  const have = new Set(attached.map(canonicalKey))
  const out: string[] = []
  for (const p of paths) {
    const key = canonicalKey(p)
    if (have.has(key)) continue
    have.add(key)
    out.push(p)
  }
  return out
}

/**
 * Attach the group's folders to an item that just joined it, and remember
 * which were added. Resolves to the paths attached.
 */
export async function inheritGroupFolders(
  surface: GroupSurface,
  itemId: string,
  groupId: string,
  adapter: FolderAdapter
): Promise<string[]> {
  const group = groups().state.surfaces[surface].groups.find((g) => g.id === groupId)
  if (!group || group.folderBindings.length === 0) return []
  const wanted = missingFolders(
    await adapter.attached(itemId),
    group.folderBindings.map((b) => b.path)
  )
  if (wanted.length === 0) return []
  const added = await adapter.attach(itemId, wanted)
  if (added.length) {
    await groups().setItemContext(surface, itemId, {
      mode: 'inherit',
      folders: added.map(folderBindingFor),
      sourceGroupId: groupId,
      updatedAt: Date.now(),
    })
  }
  return added
}

/** Folders the item took from `groupId` that are still attached to it. */
export async function inheritedFolders(
  surface: GroupSurface,
  itemId: string,
  groupId: string | null,
  adapter: FolderAdapter
): Promise<string[]> {
  if (!groupId) return []
  const context = groups().state.surfaces[surface].contexts[itemId]
  if (!context || context.sourceGroupId !== groupId) return []
  const attached = new Set((await adapter.attached(itemId)).map(canonicalKey))
  return context.folders
    .map((f) => f.path)
    .filter((p) => attached.has(canonicalKey(p)))
}

/**
 * Move an item to `target` (null: out of every group). When it leaves a group
 * whose folders it inherited, `keepFolders` is asked whether to keep them;
 * resolving false detaches them. When it joins a group, it inherits the
 * group's folders. Resolves false when nothing moved.
 */
export async function moveWithFolders(
  surface: GroupSurface,
  itemId: string,
  target: string | null,
  adapter: FolderAdapter,
  keepFolders: (paths: string[]) => Promise<boolean>
): Promise<boolean> {
  const from = groups().state.surfaces[surface].memberships[itemId]?.groupId ?? null
  if (from === target) return false
  const inherited = await inheritedFolders(surface, itemId, from, adapter)
  if (inherited.length) {
    const keep = await keepFolders(inherited)
    if (!keep) await adapter.detach(itemId, inherited)
  }
  const moved = await groups().moveItem(surface, itemId, target)
  if (!moved) return false
  if (from) await groups().setItemContext(surface, itemId, null)
  if (target) await inheritGroupFolders(surface, itemId, target, adapter)
  return true
}

/** Put a just-created item in a group and give it the group's folders. */
export async function addNewItemToGroup(
  surface: GroupSurface,
  itemId: string,
  groupId: string,
  adapter: FolderAdapter
): Promise<void> {
  const ok = await groups().moveItem(surface, itemId, groupId)
  if (ok) await inheritGroupFolders(surface, itemId, groupId, adapter)
}
