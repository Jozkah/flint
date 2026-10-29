import { Box, Folder, FolderPlus, GitFork, Lock, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { basenameOf } from '@/lib/coworkPreview'
import { truncateMiddle } from '@/lib/utils'
import type { FolderAccess, WritesKind } from '@/lib/workspaceAccess'

export const ACCESS_BADGE: Record<
  FolderAccess,
  { icon: typeof Lock; label: string; title: string }
> = {
  'read-only': {
    icon: Lock,
    label: 'common:workspace.readOnly',
    title: 'common:workspace.footnote',
  },
  editable: {
    icon: Pencil,
    label: 'common:workspace.editable',
    title: 'common:workspace.footnoteEditable',
  },
  worktree: {
    icon: GitFork,
    label: 'common:workspace.inWorktree',
    title: 'common:workspace.footnoteWorktree',
  },
}

const TOGGLE =
  'shrink-0 cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

const HEADING =
  'text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[0.025em] text-subtle-foreground uppercase'

/** A folder's access, as a small labelled badge. */
export function AccessBadge({
  kind,
  size,
}: {
  kind: FolderAccess
  size: number
}) {
  const { t } = useTranslation()
  const Icon = ACCESS_BADGE[kind].icon
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border-[0.8px] border-border bg-card px-1.5 text-[length:calc(var(--ui-font-base)*0.65625)] font-medium text-secondary-foreground"
      title={t(ACCESS_BADGE[kind].title)}
      data-access={kind}
    >
      <Icon size={size} aria-hidden />
      {t(ACCESS_BADGE[kind].label)}
    </span>
  )
}

/** A badge that is also the toggle between editable and read-only. */
export function AccessToggle({
  kind,
  size,
  folderName,
  onToggle,
  mainToggle,
}: {
  kind: FolderAccess
  size: number
  folderName: string | null
  onToggle: (writable: boolean) => void
  mainToggle?: boolean
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={TOGGLE}
      aria-label={t(
        kind === 'editable'
          ? 'common:workspace.makeReadOnly'
          : 'common:workspace.makeEditable',
        { folder: folderName }
      )}
      data-main-toggle={mainToggle ? 'true' : undefined}
      onClick={() => onToggle(kind !== 'editable')}
    >
      <AccessBadge kind={kind} size={size} />
    </button>
  )
}

/** Folders attached beside the primary one, and adding another. */
export function ExtraFoldersSection({
  extraFolders,
  extraAccess,
  canToggleExtras,
  onToggleExtraWritable,
  onAddExtra,
  onRemoveExtra,
}: {
  extraFolders: readonly string[]
  extraAccess: (extra: string) => FolderAccess
  canToggleExtras: boolean
  onToggleExtraWritable?: (folder: string, writable: boolean) => void
  onAddExtra?: () => void
  onRemoveExtra?: (folder: string) => void
}) {
  const { t } = useTranslation()
  return (
    <section className="px-2.5 pb-2.5">
      {extraFolders.length > 0 ? (
        <>
          <p className={HEADING}>{t('common:workspace.alsoAttached')}</p>
          <ul className="mt-1.5 space-y-1">
            {extraFolders.map((extra) => (
              <li key={extra} className="flex items-center gap-2">
                <Folder
                  size={13}
                  className="shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                  title={extra}
                >
                  {truncateMiddle(extra, 40)}
                </span>
                {canToggleExtras ? (
                  <AccessToggle
                    kind={extraAccess(extra)}
                    size={9}
                    folderName={basenameOf(extra)}
                    onToggle={(writable) =>
                      onToggleExtraWritable?.(extra, writable)
                    }
                  />
                ) : (
                  <AccessBadge kind={extraAccess(extra)} size={9} />
                )}
                {onRemoveExtra ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    aria-label={t('common:workspace.removeFolder', {
                      folder: basenameOf(extra),
                    })}
                    onClick={() => onRemoveExtra(extra)}
                  >
                    <X size={12} aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {onAddExtra ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1.5 h-7 px-1.5 text-xs text-muted-foreground"
          onClick={onAddExtra}
        >
          <FolderPlus size={13} aria-hidden />
          {t('common:workspace.addFolder')}
        </Button>
      ) : null}
    </section>
  )
}

/**
 * Where the agent's changes actually land. The folder above may be
 * read-only, so saying "writable project" would be a lie.
 */
export function WritesToSection({
  writesKind,
  workspacePath,
}: {
  writesKind: WritesKind
  workspacePath?: string | null
}) {
  const { t } = useTranslation()
  return (
    <section className="p-2.5">
      <p className={HEADING}>{t('common:workspace.writesTo')}</p>
      <div className="mt-1.5 flex items-start gap-2">
        <Box
          size={15}
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold">
            {writesKind === 'editable'
              ? t('common:workspace.writesFolder')
              : writesKind === 'extras'
                ? t('common:workspace.writesExtras')
                : writesKind === 'worktree'
                  ? t('common:workspace.writesWorktree')
                  : t('common:workspace.sandbox')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {writesKind === 'editable'
              ? t('common:workspace.writesFolderNote')
              : writesKind === 'extras'
                ? t('common:workspace.writesExtrasNote')
                : writesKind === 'worktree'
                  ? t('common:workspace.writesWorktreeNote')
                  : workspacePath
                    ? t('common:workspace.sandboxNote')
                    : t('common:workspace.sandboxPending')}
          </p>
        </div>
      </div>
    </section>
  )
}
