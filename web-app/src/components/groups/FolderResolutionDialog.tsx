import { useState } from 'react'
import { FolderIcon, ShieldCheck } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { effectiveFolders, type FolderChoice, type ItemFolderState } from '@/lib/groups/resolution'
import { foldersMissingFrom } from '@/lib/groups/folders'
import type { ConversationGroup, GroupFolderBinding } from '@/lib/groups/types'

export type FolderResolutionRequest = {
  itemLabel: string
  item: ItemFolderState
  group: ConversationGroup
}

const OPTIONS: { value: Exclude<FolderChoice, 'cancel'>; title: string; body: string }[] = [
  {
    value: 'keep',
    title: 'Keep item permissions',
    body: 'Only the group changes. The item keeps its folders and grants. Group folders stay organizational context.',
  },
  {
    value: 'inherit',
    title: 'Inherit group folders',
    body: 'The item’s folder context becomes the group folders. Nothing is granted: the agent asks for approval before using them.',
  },
  {
    value: 'merge',
    title: 'Merge folders',
    body: 'Adds the group folders to the item’s folder context and keeps its current folders. Access still needs approval.',
  },
  {
    value: 'addToGroup',
    title: 'Add item folders to group',
    body: 'Keeps item permissions and adds its missing folders to this group. Other members are not changed.',
  },
]

function FolderList({ title, folders }: { title: string; folders: GroupFolderBinding[] }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      {folders.length === 0 ? (
        <div className="text-xs text-muted-foreground">None</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {folders.map((f) => (
            <li key={f.canonicalPath} className="flex items-center gap-1 truncate text-xs" title={f.canonicalPath}>
              <FolderIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{f.displayName}</span>
              {f.available === false && <span className="text-warning">(unavailable)</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Asked when an item joins a group whose folders differ from the item's.
 * Every choice leaves grants untouched; see `lib/groups/resolution.ts`.
 */
export function FolderResolutionDialog({
  request,
  onChoose,
}: {
  request: FolderResolutionRequest | null
  onChoose: (choice: FolderChoice) => void
}) {
  const [choice, setChoice] = useState<Exclude<FolderChoice, 'cancel'>>('keep')
  const [confirmAdd, setConfirmAdd] = useState(false)
  if (!request) return null
  const mine = effectiveFolders(request.item)
  const missingFromGroup = foldersMissingFrom(mine, request.group.folderBindings)

  const submit = () => {
    if (choice === 'addToGroup' && !confirmAdd) return
    onChoose(choice)
    setChoice('keep')
    setConfirmAdd(false)
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          setChoice('keep')
          setConfirmAdd(false)
          onChoose('cancel')
        }
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="folder-resolution-dialog">
        <DialogHeader>
          <DialogTitle>
            Move “{request.itemLabel}” to “{request.group.name}”?
          </DialogTitle>
          <DialogDescription>
            This group’s folders differ from the item’s. Group folders say which folders belong to the work;
            permission grants decide what the agent may access. Moving an item never grants access.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4 rounded-md bg-sunken p-2">
          <FolderList title="Item folders" folders={mine} />
          <FolderList title="Group folders" folders={request.group.folderBindings} />
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">How should folders be handled?</legend>
          {OPTIONS.map((o) => {
            const disabled = o.value === 'addToGroup' && missingFromGroup.length === 0
            return (
              <label
                key={o.value}
                className={cn(
                  'flex cursor-pointer gap-2 rounded-md border border-border p-2 text-sm has-[:checked]:border-brand has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                  disabled && 'cursor-not-allowed opacity-50'
                )}
              >
                <input
                  type="radio"
                  name="folder-choice"
                  value={o.value}
                  checked={choice === o.value}
                  disabled={disabled}
                  onChange={() => setChoice(o.value)}
                  className="mt-1"
                  data-testid={`folder-choice-${o.value}`}
                />
                <span>
                  <span className="font-medium">{o.title}</span>
                  <span className="block text-xs text-muted-foreground">{o.body}</span>
                </span>
              </label>
            )
          })}
        </fieldset>

        {choice === 'addToGroup' && (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmAdd}
              onChange={(e) => setConfirmAdd(e.target.checked)}
              data-testid="confirm-add-to-group"
            />
            <span>
              Add {missingFromGroup.map((f) => f.displayName).join(', ')} to “{request.group.name}”. Other items in
              the group keep their own folder context.
            </span>
          </label>
        )}

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck aria-hidden className="size-3.5" /> No option grants read or write access.
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onChoose('cancel')}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={choice === 'addToGroup' && !confirmAdd} data-testid="folder-resolution-confirm">
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
