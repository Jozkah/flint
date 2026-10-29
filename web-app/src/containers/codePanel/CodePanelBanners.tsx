import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

const WARNING_BANNER =
  'mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg bg-warning-tint px-2.5 py-2 text-xs text-fg-2'
const LINK_BUTTON =
  'h-auto shrink-0 px-0 text-xs text-secondary-foreground underline underline-offset-2 hover:text-foreground'

/** Asks before closing tabs that hold unsaved edits. */
export function UnsavedCloseBanner({
  count,
  name,
  canSave,
  onChoose,
}: {
  /** How many dirty tabs the close would drop. */
  count: number
  /** The one dirty tab's path, when there is exactly one. */
  name: string
  /** Save is offered only for the active, editable tab. */
  canSave: boolean
  onChoose: (choice: 'save' | 'discard' | 'cancel') => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="alertdialog"
      aria-label={t('common:codePanel.unsavedTitle')}
      data-testid="code-unsaved-close"
      className="mx-3 my-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-warning-tint px-2.5 py-2 text-xs text-fg-2"
    >
      <span className="min-w-0 flex-1">
        {count === 1
          ? t('common:codePanel.unsavedOne', { name })
          : t('common:codePanel.unsavedMany', { count })}
      </span>
      {canSave && (
        <Button size="xs" onClick={() => onChoose('save')}>
          {t('common:codePanel.save')}
        </Button>
      )}
      <Button size="xs" variant="outline" onClick={() => onChoose('discard')}>
        {t('common:codePanel.discardAndClose')}
      </Button>
      <Button size="xs" variant="ghost" onClick={() => onChoose('cancel')}>
        {t('common:codePanel.cancel')}
      </Button>
    </div>
  )
}

/**
 * An external file has no path to watch, so staleness cannot be detected for
 * it — and the handle cannot be re-read for newer bytes either. The honest
 * offer is to choose the file again, which goes through the same gates as a
 * fresh open.
 */
export function ExternalFileBanner({
  onChooseAgain,
}: {
  onChooseAgain: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div role="status" className={WARNING_BANNER}>
      <span className="min-w-0 flex-1">{t('common:codePanel.externalNote')}</span>
      <Button
        size="xs"
        variant="link"
        className={LINK_BUTTON}
        onClick={onChooseAgain}
      >
        {t('common:codePanel.chooseAgainAction')}
      </Button>
    </div>
  )
}

/**
 * The agent wrote the open file since it was read. Announced, not swapped:
 * replacing the bytes under someone mid-read is what the preview pane
 * deliberately avoids.
 */
export function StaleFileBanner({
  onReload,
}: {
  onReload: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div role="status" className={WARNING_BANNER}>
      <span className="min-w-0 flex-1">{t('common:codePanel.stale')}</span>
      <Button size="xs" variant="link" className={LINK_BUTTON} onClick={onReload}>
        {t('common:codePanel.reload')}
      </Button>
    </div>
  )
}

/** The disk moved under unsaved edits; the user picks which side wins. */
export function ConflictBanner({
  onResolve,
}: {
  onResolve: (choice: 'overwrite' | 'reload' | 'keep') => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      data-testid="code-conflict"
      className="mx-3 mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-warning-tint px-2.5 py-2 text-xs text-fg-2"
    >
      <span className="min-w-0 flex-1">{t('common:codePanel.conflict')}</span>
      <Button size="xs" variant="outline" onClick={() => onResolve('reload')}>
        {t('common:codePanel.conflictReload')}
      </Button>
      <Button size="xs" variant="outline" onClick={() => onResolve('overwrite')}>
        {t('common:codePanel.conflictOverwrite')}
      </Button>
      <Button size="xs" variant="ghost" onClick={() => onResolve('keep')}>
        {t('common:codePanel.conflictKeep')}
      </Button>
    </div>
  )
}

export function SaveErrorBanner({ error }: { error: string }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="mx-3 mb-2 shrink-0 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
    >
      {t('common:codePanel.saveFailed', { error })}
    </div>
  )
}
