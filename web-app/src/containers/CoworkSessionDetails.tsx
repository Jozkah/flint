import { useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * One compact control for everything about the session that is reference
 * material rather than conversation: which repository and branch, the mode, the
 * workspace, the instruction files, the skills and tools that were found, the
 * model and its context accounting, and the Claude-compatibility surface.
 *
 * All of that used to sit expanded between the transcript and the composer,
 * where it pushed the conversation up the screen and stayed there while the
 * user typed. It is the same information; it is now behind a control that is
 * closed until asked for, so the composer sits directly beneath the last thing
 * that was said.
 */
export function CoworkSessionDetails({
  children,
  summary,
}: {
  /** The detail surfaces, rendered only while the dialog is open. */
  children: ReactNode
  /** A few words for the trigger, e.g. the repository and branch. */
  summary?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="session-details-trigger"
          className="flex max-w-[16rem] items-center gap-1.5 rounded-md px-2 py-1 text-xs text-main-view-fg/60 hover:bg-main-view-fg/5 hover:text-main-view-fg focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Info size={13} className="shrink-0" />
          <span className="truncate">
            {summary || t('common:sessionDetails.title')}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[80dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('common:sessionDetails.title')}</DialogTitle>
          <DialogDescription>
            {t('common:sessionDetails.description')}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so nothing here scans the disk or reads a
            manifest for a panel nobody asked to see. */}
        {open && (
          <div
            className="flex flex-col gap-3"
            data-testid="session-details-body"
          >
            {children}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default CoworkSessionDetails
