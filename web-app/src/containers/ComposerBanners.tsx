import { Globe, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { displayNameOf } from '@/lib/displayName'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Above the editor: a pasted or dropped path, offered as an attachment. */
export function PathOfferBanner({
  path,
  kind,
  onAccept,
  onDecline,
}: {
  path: string
  kind: 'file' | 'folder'
  onAccept: () => void
  onDecline: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="mx-2 mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs text-secondary-foreground"
    >
      <span className="min-w-0 flex-1 truncate" title={path}>
        {t(
          kind === 'folder'
            ? 'common:pastedPath.folder'
            : 'common:pastedPath.file',
          { name: displayNameOf(path) }
        )}
      </span>
      <button
        type="button"
        onClick={onAccept}
        className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
      >
        {t('common:pastedPath.attach')}
      </button>
      <button
        type="button"
        aria-label={t('common:pastedPath.dismiss')}
        onClick={onDecline}
        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X aria-hidden className="size-3" />
      </button>
    </div>
  )
}

/** A send held back because it needs the web and web search is off. */
export function WebSearchOffPrompt({
  onEnable,
  onSendAnyway,
}: {
  onEnable: () => void
  onSendAnyway: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      data-testid="web-search-off-prompt"
      className="mt-1.5 mx-1 flex flex-wrap items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-3 py-1.5 text-xs"
    >
      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground">
        {t('common:webSearchOff.text')}
      </span>
      <Button
        size="sm"
        variant="default"
        className="h-6 px-2 text-xs"
        onClick={onEnable}
      >
        {t('common:webSearchOff.enable')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={onSendAnyway}
      >
        {t('common:webSearchOff.sendAnyway')}
      </Button>
    </div>
  )
}

/** The composer's error line (rejected files and the like), dismissible. */
export function ComposerErrorLine({
  message,
  onDismiss,
}: {
  message: string
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="mt-1.5 mx-1 rounded-lg border-[0.8px] border-destructive/30 bg-destructive-tint px-3 py-1.5 text-xs text-destructive"
    >
      <div className="flex items-center gap-2 justify-between">
        <span className="min-w-0 wrap-break-word">{message}</span>
        <button
          type="button"
          aria-label={t('common:dismiss')}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
