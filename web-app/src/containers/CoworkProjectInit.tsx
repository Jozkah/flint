/**
 * Describe an attached project: a bounded survey proposes a starting
 * `FLINT.md`, the user edits it, and it is written only when they accept it.
 * AH-209.
 *
 * Offered only while the folder has no `FLINT.md`. The draft is kept per
 * folder until it is accepted or discarded, so closing the dialog -- or the
 * app -- loses no edit. A survey still running when the dialog closes is
 * abandoned: its result is dropped rather than stored.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import {
  projectInitAccept,
  projectSurvey,
} from '@janhq/tauri-plugin-agent-tools-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getServiceHub } from '@/hooks/useServiceHub'
import { errorText } from '@/lib/errorText'
import { useProjectInitDrafts } from '@/lib/projectInit'

/** The offer's label: a saved draft is continued rather than started over. */
export const projectInitLabel = (hasDraft: boolean) =>
  hasDraft ? 'Continue the FLINT.md draft' : 'Describe this project'

export function CoworkProjectInit({
  folder,
  hasInstructions,
  onAccepted,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  /** Controlled open state, for a trigger that lives elsewhere. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Render only the dialog; another control opens it. */
  hideTrigger?: boolean
  folder: string | null
  /** The folder already has a `FLINT.md`; nothing is offered. */
  hasInstructions: boolean
  /** `FLINT.md` was written; whatever reads it should read it again. */
  onAccepted?: () => void
}) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = openProp ?? innerOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInnerOpen(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange]
  )
  const [busy, setBusy] = useState<'survey' | 'accept' | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const draft = useProjectInitDrafts((s) =>
    folder ? s.draftFor(folder) : null
  )
  // A survey belongs to the dialog that asked for it.
  const surveyToken = useRef(0)

  useEffect(() => {
    if (!open) surveyToken.current += 1
  }, [open])

  const runSurvey = useCallback(async () => {
    if (!folder) return
    const token = ++surveyToken.current
    setBusy('survey')
    setError(null)
    setStatus('Surveying the folder…')
    try {
      const dataFolder = await getServiceHub().app().getJanDataFolder()
      const found = await projectSurvey(dataFolder ?? '', folder)
      if (token !== surveyToken.current) return
      useProjectInitDrafts.getState().setDraft(folder, {
        content: found.draft,
        notRead: found.notRead,
        read: found.read,
        surveyedAt: Date.now(),
      })
      setStatus(
        `Surveyed ${found.filesSeen} files and read ${found.read.length}. Nothing has been written.`
      )
    } catch (e) {
      if (token !== surveyToken.current) return
      setError(errorText(e))
      setStatus('')
    } finally {
      if (token === surveyToken.current) setBusy(null)
    }
  }, [folder])

  // Opening with no draft yet starts the survey, whichever control opened it.
  const hasDraft = Boolean(draft)
  useEffect(() => {
    if (open && !hasDraft) void runSurvey()
    // Only on opening: a failed survey is retried from the dialog, not looped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const begin = () => setOpen(true)

  const accept = async () => {
    if (!folder || !draft) return
    setBusy('accept')
    setError(null)
    try {
      const dataFolder = await getServiceHub().app().getJanDataFolder()
      await projectInitAccept(dataFolder ?? '', folder, draft.content)
      useProjectInitDrafts.getState().clear(folder)
      setStatus('Wrote FLINT.md')
      setOpen(false)
      onAccepted?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const discard = () => {
    if (!folder) return
    useProjectInitDrafts.getState().clear(folder)
    setStatus('Draft discarded. Nothing was written.')
    setOpen(false)
  }

  // The live region outlives the offer: accepting writes FLINT.md, which takes
  // the offer away, and the announcement of the write must not go with it.
  const announcement = (
    <span
      role="status"
      aria-live="polite"
      className="sr-only"
      data-testid="project-init-status"
    >
      {status}
    </span>
  )

  if (!folder || hasInstructions) return announcement

  return (
    <>
      {!hideTrigger && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 text-xs"
          onClick={begin}
          data-testid="project-init-open"
        >
          <FileText aria-hidden className="size-3.5" />
          {projectInitLabel(Boolean(draft))}
        </Button>
      )}
      {announcement}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl" data-testid="project-init-dialog">
          <DialogHeader>
            <DialogTitle>Describe this project</DialogTitle>
            <DialogDescription>
              Flint read the folder's manifests and layout and ran nothing. Edit
              the description; it becomes the folder's FLINT.md only when you
              accept it.
            </DialogDescription>
          </DialogHeader>
          {busy === 'survey' && !draft ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Surveying the folder…
            </p>
          ) : draft ? (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="project-init-text"
                className="text-xs font-medium text-muted-foreground"
              >
                FLINT.md
              </label>
              <textarea
                id="project-init-text"
                className="h-72 w-full resize-y rounded-lg border-[0.8px] border-input bg-code-bg p-2.5 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                value={draft.content}
                onChange={(e) =>
                  useProjectInitDrafts
                    .getState()
                    .editDraft(folder, e.target.value)
                }
                data-testid="project-init-text"
              />
              {draft.notRead.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary>What the survey did not read</summary>
                  <ul
                    className="mt-1 list-disc pl-4"
                    data-testid="project-init-not-read"
                  >
                    {draft.notRead.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ) : null}
          {error && (
            <p
              role="alert"
              className="text-sm text-destructive"
              data-testid="project-init-error"
            >
              {error}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={discard}
              disabled={!draft || busy !== null}
              data-testid="project-init-discard"
            >
              Discard draft
            </Button>
            <Button
              variant="outline"
              onClick={() => void runSurvey()}
              disabled={busy !== null}
              data-testid="project-init-resurvey"
            >
              Survey again
            </Button>
            <Button
              onClick={() => void accept()}
              disabled={!draft || busy !== null}
              data-testid="project-init-accept"
            >
              Accept and write FLINT.md
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
