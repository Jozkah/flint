import { useEffect, useState, type ReactNode } from 'react'
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
import { useTranslation } from '@/i18n/react-i18next-compat'

/** A stand-in for a styled node inside a translated sentence. */
const SLOT = '\u0000'

/** Puts `node` where the translation placed `{{slot}}`. */
function withSlot(text: string, node: ReactNode): ReactNode {
  const [before, after] = text.split(SLOT)
  return (
    <>
      {before}
      {after === undefined ? null : node}
      {after}
    </>
  )
}

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
  const { t } = useTranslation()
  const head = useAccessRequests((s) => s.queue[0])
  const waiting = useAccessRequests((s) => s.queue.length)
  const answer = useAccessRequests((s) => s.answer)

  useEffect(() => useAccessRequests.getState().attachPresenter(), [])

  // The grant buttons wait a moment after each new request, so a click or
  // Enter meant for the previous one cannot grant the next path.
  const headId = head?.id
  const [armedFor, setArmedFor] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (headId === undefined) return
    const timer = setTimeout(() => setArmedFor(headId), 400)
    return () => clearTimeout(timer)
  }, [headId])

  if (!head) return null
  const armed = armedFor === head.id
  const { prepared } = head
  const write = prepared.mode === 'write'
  const Icon = write ? PenLine : prepared.isDir ? FolderLock : FileLock

  return (
    <Dialog
      key={head.id}
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
            {t(
              `permissions:accessRequest.${write ? 'title.write' : 'title.read'}.${prepared.isDir ? 'folder' : 'file'}`
            )}
          </DialogTitle>
          <DialogDescription>
            {withSlot(
              head.origin
                ? t('permissions:accessRequest.askingFrom', {
                    origin: head.origin,
                    task: SLOT,
                  })
                : t('permissions:accessRequest.asking', { task: SLOT }),
              <span className="font-medium text-foreground">
                {head.taskLabel ||
                  t('permissions:accessRequest.thisConversation')}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">
              {prepared.isDir
                ? t('permissions:accessRequest.folderLabel')
                : t('permissions:accessRequest.fileLabel')}
            </div>
            <code
              className="mt-1 block break-all rounded bg-muted px-2 py-1.5 font-mono text-xs"
              data-testid="access-path"
            >
              {prepared.display}
            </code>
            {prepared.resolvedDiffers && (
              <div className="mt-1 text-xs text-muted-foreground">
                {withSlot(
                  t('permissions:accessRequest.requestedAs', {
                    requested: SLOT,
                  }),
                  <code className="break-all">{prepared.requested}</code>
                )}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              {t('permissions:accessRequest.reason')}
            </div>
            <div className="mt-1 whitespace-pre-wrap" data-testid="access-reason">
              {head.reason}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {t('permissions:accessRequest.access')}
            </span>
            <span
              className={
                write
                  ? 'rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive'
                  : 'rounded bg-muted px-1.5 py-0.5 font-medium'
              }
              data-testid="access-mode"
            >
              {write
                ? t('permissions:accessRequest.readWrite')
                : t('permissions:accessRequest.readOnly')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('permissions:accessRequest.grantNote')}
          </p>
          {waiting > 1 && (
            <p className="text-xs text-muted-foreground">
              {t('permissions:accessRequest.moreWaiting', { count: waiting - 1 })}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            data-testid="access-deny"
            onClick={() => answer(head.id, 'deny')}
          >
            {t('permissions:accessRequest.deny')}
          </Button>
          <Button
            variant="outline"
            data-testid="access-always"
            disabled={!armed}
            onClick={() => answer(head.id, 'always')}
          >
            {t('permissions:accessRequest.always')}
          </Button>
          <Button
            data-testid="access-session"
            disabled={!armed}
            onClick={() => answer(head.id, 'session')}
          >
            {t('permissions:accessRequest.session')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AccessRequestDialog
