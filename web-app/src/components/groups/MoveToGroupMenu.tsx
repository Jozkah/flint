import { FolderIcon, FolderPlus, Inbox } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useGroupedNav } from './context'

/**
 * "Move to group" submenu for a row's existing menu: the non-drag way to change
 * membership. Uses the same permission flow as a drop. Renders nothing outside
 * a GroupedNav.
 */
export function MoveToGroupMenu({ itemId }: { itemId: string }) {
  const nav = useGroupedNav()
  if (!nav) return null
  const current = nav.groupIdOf(itemId)
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <FolderIcon className="size-4" />
          <span>Move to group</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-72 min-w-48 overflow-y-auto">
          {nav.groups
            .filter((g) => g.id !== current)
            .map((g) => (
              <DropdownMenuItem key={g.id} onSelect={() => void nav.requestMove(itemId, g.id)}>
                <FolderIcon className="size-4" />
                <span className="max-w-[200px] truncate">{g.name}</span>
              </DropdownMenuItem>
            ))}
          <DropdownMenuItem onSelect={() => nav.createGroupWith(itemId)}>
            <FolderPlus className="size-4" />
            <span>New group…</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {current && (
        <DropdownMenuItem onSelect={() => void nav.requestMove(itemId, null)}>
          <Inbox className="size-4" />
          <span>Move to Recents</span>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  )
}
