import {
  Box,
  Copy,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
  Lock,
  Pencil,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { basenameOf } from '@/lib/coworkPreview'
import { truncateMiddle } from '@/lib/utils'

type AccessMode = 'review-only' | 'managed-worktree' | 'edit-folder'

/** What a folder's badge says: read-only, editable, or edited via a worktree. */
type FolderAccess = 'read-only' | 'editable' | 'worktree'

const BADGE: Record<
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

/** The primary folder's access under `access`. */
export const primaryFolderAccess = (access?: AccessMode): FolderAccess =>
  access === 'edit-folder'
    ? 'editable'
    : access === 'managed-worktree'
      ? 'worktree'
      : 'read-only'

type Props = {
  /** Attached project folder, or null when the session is sandbox-only. */
  folder: string | null
  /** The session sandbox writes land in; null until it has been created. */
  workspacePath?: string | null
  gitBranch?: string | null
  onAttach: () => void
  onDetach: () => void
  /**
   * The session's effective access, which decides what each folder's badge
   * says. Absent reads as Review only: a label must never claim more than
   * the backend grants.
   */
  access?: AccessMode
  /** Folders attached beside `folder`, like a multi-root workspace. */
  extraFolders?: readonly string[]
  /** Whether the run's grant covers `extraFolders` (attached directly). */
  extraFoldersWritable?: boolean
  /** Pick another folder to attach beside the primary one. */
  onAddExtra?: () => void
  onRemoveExtra?: (folder: string) => void
}

/**
 * Attach, inspect and detach the read-only project folder.
 *
 * The sandbox it writes into is deliberately unnamed: it is an implementation
 * detail the user never picks or opens, and surfacing it invited the reading
 * that the folder and the sandbox are two halves of one choice. What has to
 * stay visible is the read-only contract on the folder.
 *
 * The trigger is icon-only until a folder is attached, matching the composer
 * row's other controls: with nothing attached there is no name to print, and a
 * pill reading "Attach a folder" outweighed every icon beside it.
 */
export function CoworkWorkspacePill({
  folder,
  workspacePath,
  gitBranch,
  onAttach,
  onDetach,
  access = 'review-only',
  extraFolders = [],
  extraFoldersWritable = false,
  onAddExtra,
  onRemoveExtra,
}: Props) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const folderName = folder ? basenameOf(folder) : null
  const primaryAccess = primaryFolderAccess(access)
  const extraAccess: FolderAccess =
    access !== 'review-only' && extraFoldersWritable ? 'editable' : 'read-only'
  const TriggerIcon = BADGE[primaryAccess].icon
  const badge = (kind: FolderAccess, size: number) => {
    const Icon = BADGE[kind].icon
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border-[0.8px] border-border bg-card px-1.5 text-[10.5px] font-medium text-secondary-foreground"
        title={t(BADGE[kind].title)}
        data-access={kind}
      >
        <Icon size={size} aria-hidden />
        {t(BADGE[kind].label)}
      </span>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={folderName ? 'outline' : 'ghost'}
          size={folderName ? 'xs' : 'icon-xs'}
          className={
            folderName
              ? 'h-[30px] shrink-0 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground pointer-coarse:h-11'
              : 'size-[30px] shrink-0 text-muted-foreground pointer-coarse:size-11'
          }
          aria-label={
            folderName
              ? t('common:workspace.a11yWithFolder', { folder: folderName })
              : t('common:workspace.a11yNoFolder')
          }
        >
          {folderName ? (
            <>
              {gitBranch ? (
                <GitBranch className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <Folder className="size-3.5 shrink-0" aria-hidden />
              )}
              <span className="max-w-[120px] truncate text-secondary-foreground">
                {folderName}
              </span>
              {gitBranch ? (
                <span
                  aria-hidden
                  className="hidden max-w-[96px] truncate font-normal text-muted-foreground xl:inline"
                >
                  · {gitBranch}
                </span>
              ) : null}
              {extraFolders.length > 0 ? (
                <span aria-hidden className="font-normal text-muted-foreground">
                  +{extraFolders.length}
                </span>
              ) : null}
              <TriggerIcon
                className="size-3 shrink-0 text-muted-foreground"
                aria-hidden
                data-access={primaryAccess}
              />
            </>
          ) : (
            <FolderPlus className="size-[18px] shrink-0" />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        // Narrow windows: never wider than the viewport, and never taller
        // than the space above the composer it is anchored to.
        className="w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(28rem,60vh)] overflow-y-auto p-1.5"
        aria-label={t('common:workspace.actionsLabel')}
      >
        {folder ? (
          <>
            {/* What is attached */}
            <section className="p-2.5">
              <p className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                {t('common:workspace.readsFrom')}
              </p>
              <div className="mt-1.5 flex items-start gap-2">
                <Folder
                  size={15}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold">
                    {folderName}
                  </p>
                  <p
                    className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                    title={folder}
                  >
                    {truncateMiddle(folder, 40)}
                  </p>
                </div>
                {badge(primaryAccess, 10)}
              </div>
              {gitBranch && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch size={12} aria-hidden />
                  <span className="sr-only">
                    {t('common:workspace.branchLabel')}:{' '}
                  </span>
                  <span className="text-fade font-mono">{gitBranch}</span>
                </p>
              )}
            </section>

            {/* Folders attached beside the primary one. Each is treated like
                it; the shell still starts in the primary. */}
            {extraFolders.length > 0 || onAddExtra ? (
              <section className="px-2.5 pb-2.5">
                {extraFolders.length > 0 ? (
                  <>
                    <p className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                      {t('common:workspace.alsoAttached')}
                    </p>
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
                          {badge(extraAccess, 9)}
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
            ) : null}

            <Separator className="my-0.5 bg-transparent border-t border-dashed border-border" />

            {/* Where the agent's changes actually land. The folder above is
                read-only, so saying "writable project" would be a lie. */}
            <section className="p-2.5">
              <p className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                {t('common:workspace.writesTo')}
              </p>
              <div className="mt-1.5 flex items-start gap-2">
                <Box
                  size={15}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold">
                    {primaryAccess === 'editable'
                      ? t('common:workspace.writesFolder')
                      : primaryAccess === 'worktree'
                        ? t('common:workspace.writesWorktree')
                        : t('common:workspace.sandbox')}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {primaryAccess === 'editable'
                      ? t('common:workspace.writesFolderNote')
                      : primaryAccess === 'worktree'
                        ? t('common:workspace.writesWorktreeNote')
                        : workspacePath
                          ? t('common:workspace.sandboxNote')
                          : t('common:workspace.sandboxPending')}
                  </p>
                </div>
              </div>
            </section>

            <Separator className="my-0.5 bg-transparent border-t border-dashed border-border" />

            {/* Reaching the folder */}
            <section className="flex flex-wrap gap-1.5 p-1.5">
              <Button
                variant="surface"
                size="sm"
                className="flex-1"
                onClick={() => void serviceHub.opener().openPath(folder)}
              >
                <FolderOpen size={14} aria-hidden />
                {t('common:workspace.open')}
              </Button>
              <Button
                variant="surface"
                size="sm"
                className="flex-1"
                onClick={() => void serviceHub.opener().revealItemInDir(folder)}
              >
                <ExternalLink size={14} aria-hidden />
                {t('common:workspace.reveal')}
              </Button>
              <Button
                variant="surface"
                size="sm"
                className="flex-1"
                onClick={() => void navigator.clipboard?.writeText(folder)}
              >
                <Copy size={14} aria-hidden />
                {t('common:workspace.copyPath')}
              </Button>
            </section>

            <Separator className="my-0.5 bg-transparent border-t border-dashed border-border" />

            {/* Changing the attachment. Detaching is the disruptive one, so it
                sits apart from the rest rather than beside them. */}
            <section className="flex items-center gap-2 p-1.5">
              <Button variant="surface" size="sm" onClick={onAttach}>
                {t('common:workspace.change')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="ml-auto"
                onClick={onDetach}
              >
                {t('common:workspace.detach')}
              </Button>
            </section>
          </>
        ) : (
          <section className="p-2.5">
            <p className="text-xs text-muted-foreground">
              {t('common:workspace.footnoteEmpty')}
            </p>
            <Button
              variant="surface"
              size="sm"
              className="mt-3 w-full"
              onClick={onAttach}
            >
              <FolderPlus size={14} aria-hidden />
              {t('common:workspace.attach')}
            </Button>
          </section>
        )}
      </PopoverContent>
    </Popover>
  )
}
