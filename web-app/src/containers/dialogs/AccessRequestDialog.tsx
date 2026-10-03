import { useEffect } from 'react'
import { FolderLock, FileLock, PenLine } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAccessRequests } from '@/lib/accessRequests'

/**
 * The prompt for a `request_access` call.
 *
 * Shows what a grant would actually enforce -- the canonical path the backend
 * resolved, not the model's spelling of it -- with the model's reason, the
 * mode, and which conversation is asking. Esc denies, a click outside does nothing,
 * and focus starts on Deny, so a reflexive Enter never grants anything.
 *
 * Mounted once at the root. While it is mounted the store knows someone can
 * answer; with it gone, a request is answered "unavailable" at once rather
 * than waiting on a prompt nobody will see.
 */
export function AccessRequestDialog() {
  const head = useAccessRequests((s) => s.queue[0])
  const waiting = useAccessRequests((s) => s.queue.length)
  const answer = useAccessRequests((s) => s.answer)

  useEffect(() => useAccessRequests.getState().attachPresenter(), [])

  if (!head) return null
  const { prepared } = head
  const write = prepared.mode === 'write'
  const Icon = write ? PenLine : prepared.isDir ? FolderLock : FileLock

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) answer(head.id, 'deny')
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        data-testid="access-request-dialog"
        // A click outside is not an answer: it used to deny, which refused
        // requests the user never meant to decline. Esc and Deny still do.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          document
            .querySelector<HTMLButtonElement>('[data-testid="access-deny"]')
            ?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-4 shrink-0" />
            {write
              ? `Allow the agent to change files in this ${prepared.isDir ? 'folder' : 'file'}?`
              : `Allow the agent to read this ${prepared.isDir ? 'folder' : 'file'}?`}
          </DialogTitle>
          <DialogDescription>
            {head.origin ? `${head.origin} in ` : ''}
            <span className="font-medium text-foreground">
              {head.taskLabel || 'this conversation'}
            </span>{' '}
            is asking for access outside its workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">
              {prepared.isDir ? 'Folder (and everything inside it)' : 'File'}
            </div>
            <code
              className="mt-1 block break-all rounded bg-muted px-2 py-1.5 font-mono text-xs"
              data-testid="access-path"
            >
              {prepared.display}
            </code>
            {prepared.resolvedDiffers && (
              <div className="mt-1 text-xs text-muted-foreground">
                Requested as <code className="break-all">{prepared.requested}</code>,
                which resolves to the path above.
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Reason given</div>
            <div className="mt-1 whitespace-pre-wrap" data-testid="access-reason">
              {head.reason}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Access:</span>
            <span
              className={
                write
                  ? 'rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive'
                  : 'rounded bg-muted px-1.5 py-0.5 font-medium'
              }
              data-testid="access-mode"
            >
              {write ? 'Read and write' : 'Read only'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            "Allow for this conversation" ends when the conversation does, or
            after 8 hours. "Always allow" keeps it for every conversation until
            you revoke it in Settings &gt; Permissions &gt; Folder access.
          </p>
          {waiting > 1 && (
            <p className="text-xs text-muted-foreground">
              {waiting - 1} more request{waiting > 2 ? 's' : ''} waiting.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            data-testid="access-deny"
            onClick={() => answer(head.id, 'deny')}
          >
            Deny
          </Button>
          <Button
            variant="outline"
            data-testid="access-always"
            onClick={() => answer(head.id, 'always')}
          >
            Always allow
          </Button>
          <Button
            data-testid="access-session"
            onClick={() => answer(head.id, 'session')}
          >
            Allow for this conversation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AccessRequestDialog
