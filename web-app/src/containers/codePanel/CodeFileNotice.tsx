import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { FileState } from '@/lib/coworkCodeRead'

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
      <div>{children}</div>
    </div>
  )
}

type Props = {
  /** Any state but `ready`; undefined while nothing has been asked yet. */
  file: Exclude<FileState, { status: 'ready' }> | undefined
  /** The tab's path, named in the missing notice. */
  path: string
  /** Read the tab again; `allowSensitive` opens a refused sensitive file. */
  onReload: (allowSensitive?: boolean) => void
  onCloseTab: () => void
  onAttach: () => void
  onChooseAgain: () => void
  onOpenExternally: () => void
}

/** Why the active tab shows no content, and what can be done about it. */
export function CodeFileNotice({
  file,
  path,
  onReload,
  onCloseTab,
  onAttach,
  onChooseAgain,
  onOpenExternally,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const closeButton = (
    <Button size="sm" variant="ghost" onClick={onCloseTab}>
      {t('common:codePanel.closeMissing')}
    </Button>
  )
  if (!file || file.status === 'loading') {
    return <Notice>{t('common:codePanel.loading')}</Notice>
  }
  switch (file.status) {
    case 'oversized':
      return (
        <Notice>
          <span className="block">
            {t('common:codePanel.tooLarge', {
              size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
            })}
          </span>
          <span className="mt-1 block text-muted-foreground">
            {file.preview
              ? t('common:codePanel.openExternallyPreview')
              : t('common:codePanel.openExternally')}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            data-testid="code-open-external"
            onClick={onOpenExternally}
          >
            {t('common:codePanel.openExternallyAction')}
          </Button>
          {file.preview ? (
            <pre
              data-testid="code-oversized-preview"
              className="mt-3 max-h-64 overflow-auto rounded-md bg-code-bg p-2 text-left font-mono text-xs"
            >
              {file.preview.slice(0, 16384)}
            </pre>
          ) : null}
        </Notice>
      )
    case 'binary':
      return (
        <Notice>
          <span className="block" data-testid="code-binary-notice">
            {t('common:codePanel.binary')}
          </span>
          <span className="mt-2 flex justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="code-open-external"
              onClick={onOpenExternally}
            >
              {t('common:codePanel.openExternallyAction')}
            </Button>
            {closeButton}
          </span>
        </Notice>
      )
    case 'missing':
      return (
        <Notice>
          <span
            className="block"
            data-testid="code-missing-notice"
            title={file.detail}
          >
            {t('common:codePanel.fileMissing', { name: path })}
          </span>
          <span className="mt-2 flex justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => onReload()}>
              {t('common:codePanel.retry')}
            </Button>
            {closeButton}
          </span>
        </Notice>
      )
    case 'denied':
      return <Notice>{t('common:codePanel.denied')}</Notice>
    case 'detached':
      // The project went away underneath this tab. Not an error and not a
      // spinner that will never resolve — say what happened and let the tab
      // be closed.
      return (
        <Notice>
          <span className="block">{t('common:codePanel.detached')}</span>
          <span className="mt-2 flex justify-center gap-2">
            <Button size="sm" onClick={onAttach}>
              {t('common:codePanel.attachProject')}
            </Button>
            {closeButton}
          </span>
        </Notice>
      )
    case 'external-gone':
      // Nothing to reload from: say so, and offer the only thing that can
      // actually produce the file again.
      return (
        <Notice>
          <span className="block">{t('common:codePanel.externalGone')}</span>
          <span className="mt-2 flex justify-center gap-2">
            <Button size="sm" onClick={onChooseAgain}>
              {t('common:codePanel.chooseAgainAction')}
            </Button>
            {closeButton}
          </span>
        </Notice>
      )
    case 'sensitive':
      return (
        <Notice>
          <span className="block">{t('common:codePanel.sensitive')}</span>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => onReload(true)}
          >
            {t('common:codePanel.openAnyway')}
          </Button>
        </Notice>
      )
    default:
      return (
        <Notice>
          <span className="block">{file.message}</span>
          <span className="mt-2 flex justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => onReload()}>
              {t('common:codePanel.retry')}
            </Button>
            {closeButton}
          </span>
        </Notice>
      )
  }
}
