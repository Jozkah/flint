import { useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  inline = false,
}: {
  /** The detail surfaces, rendered only while the dialog is open. */
  children: ReactNode
  /** Named on the trigger's tooltip and label, not on its face. */
  summary?: string
  /**
   * On phones the details are a view of their own rather than a dialog over
   * the conversation: the same surfaces, mounted in the page.
   */
  inline?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (inline) {
    return (
      <section
        aria-labelledby="cowork-session-details-heading"
        className="flex flex-col gap-3"
      >
        <header className="flex flex-col gap-1">
          <h2
            id="cowork-session-details-heading"
            className="text-[15px] font-semibold text-foreground"
          >
            {t('common:sessionDetails.title')}
          </h2>
          <p className="text-[13px] leading-[1.45] text-muted-foreground">
            {summary || t('common:sessionDetails.description')}
          </p>
        </header>
        <div className="flex flex-col gap-3" data-testid="session-details-body">
          {children}
        </div>
      </section>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* The same primitive, variant and icon size as the chat page's
            header control, so the two headers match without either page
            describing its own padding. The repository and branch this would
            have spelled out are on the label, and first inside when it opens. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          data-testid="session-details-trigger"
          title={summary || t('common:sessionDetails.title')}
          aria-label={
            summary
              ? `${t('common:sessionDetails.title')} — ${summary}`
              : t('common:sessionDetails.title')
          }
        >
          <Info size={16} />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80dvh] max-w-[680px] overflow-y-auto">
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
