import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useConversationGroups } from '@/lib/groups/store'
import { moveWithFolders, type FolderAdapter } from '@/lib/groups/inherit'
import { useKeepFoldersPrompt } from '@/lib/groups/keepPrompt'
import type { GroupSurface } from '@/lib/groups/types'

/**
 * Move an item into a group (or out, with null) with the folder questions
 * asked in the surface's `GroupPrompts`, and say where it went. Resolves
 * whether it moved.
 */
export function useMoveToGroup(surface: GroupSurface, adapter: FolderAdapter) {
  const { t } = useTranslation()
  return async (itemId: string, target: string | null): Promise<boolean> => {
    const { state } = useConversationGroups.getState()
    const groups = state.surfaces[surface].groups
    const from = state.surfaces[surface].memberships[itemId]?.groupId ?? null
    const fromName = groups.find((g) => g.id === from)?.name ?? ''
    const prompts = useKeepFoldersPrompt.getState()
    try {
      const moved = await moveWithFolders(
        surface,
        itemId,
        target,
        adapter,
        (paths) => prompts.ask(surface, fromName, paths),
        (own, group) => prompts.askJoin(surface, own, group)
      )
      if (!moved) return false
      const g = groups.find((x) => x.id === target)
      toast.success(
        g ? t('common:groups.movedTo', { name: g.name }) : t('common:groups.movedOut')
      )
      return true
    } catch (err) {
      toast.error(String(err))
      return false
    }
  }
}
