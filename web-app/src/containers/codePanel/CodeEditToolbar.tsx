import { Pencil, WrapText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CodeOverlayMenu } from '@/containers/CodeGitOverlays'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { detectLanguage } from '@/lib/coworkCode'
import { cn } from '@/lib/utils'

type Props = {
  path: string
  /** A project file whose saves land in the session sandbox (Review only). */
  savesToSandbox: boolean
  dirty: boolean
  saving: boolean
  wordWrap: boolean
  onToggleWrap: () => void
  /** Shown when a Review only run made its own copy of this file. */
  showAgentCopy: boolean
  onOpenAgentCopy: () => void
  onDiscard: () => void
  onSave: () => void
}

/** The header above the editor: mode badge, path, wrap and save controls. */
export function CodeEditToolbar({
  path,
  savesToSandbox,
  dirty,
  saving,
  wordWrap,
  onToggleWrap,
  showAgentCopy,
  onOpenAgentCopy,
  onDiscard,
  onSave,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 px-3 pointer-coarse:h-11">
      <span
        data-testid="code-edit-badge"
        className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-secondary-foreground"
        title={savesToSandbox ? t('common:codePanel.editingSandboxHint') : undefined}
      >
        <Pencil className="size-3" aria-hidden />
        {savesToSandbox
          ? t('common:codePanel.editingSandbox')
          : t('common:codePanel.editing')}
      </span>
      <span
        className="min-w-0 flex-1 truncate px-1 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground"
        title={path}
      >
        {path}
        {dirty && (
          <span className="ml-1 text-foreground">
            {t('common:codePanel.unsavedMark')}
          </span>
        )}
      </span>
      <span className="shrink-0 pr-1 text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground">
        {detectLanguage(path).label}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:codePanel.toggleWrap')}
        aria-pressed={wordWrap}
        onClick={onToggleWrap}
        className={cn(
          'shrink-0 pointer-coarse:size-11',
          wordWrap ? 'bg-accent text-foreground' : 'text-muted-foreground'
        )}
      >
        <WrapText className="size-3.5" />
      </Button>
      <CodeOverlayMenu />
      {showAgentCopy ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={onOpenAgentCopy}
          title={t('common:codePanel.sandboxChangesHint')}
          data-testid="open-sandbox-copy"
        >
          {t('common:codePanel.openSandboxCopy')}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={!dirty || saving}
        onClick={onDiscard}
      >
        {t('common:codePanel.discard')}
      </Button>
      <Button
        size="xs"
        disabled={!dirty || saving}
        onClick={onSave}
        title={t('common:codePanel.saveHint')}
      >
        {saving ? t('common:codePanel.saving') : t('common:codePanel.save')}
      </Button>
    </div>
  )
}
