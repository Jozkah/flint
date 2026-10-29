import { useState } from 'react'
import { FadeText } from '@/components/ui/fade-text'
import {
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
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
import { useComposerCollapsed } from '@/containers/ComposerDensity'
import { type AccessMode, workspaceAccess } from '@/lib/workspaceAccess'
import {
  ACCESS_BADGE,
  AccessBadge,
  AccessToggle,
  ExtraFoldersSection,
  WritesToSection,
} from './cowork-workspace/WorkspaceSections'

export { primaryFolderAccess } from '@/lib/workspaceAccess'

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
  /** Whether a grant can cover `extraFolders` at all (attached directly). */
  extraFoldersWritable?: boolean
  /** Extra folders the user marked read-only; the rest follow `access`. */
  readOnlyExtraFolders?: readonly string[]
  /**
   * Toggle one extra folder between editable and read-only. Offered wherever
   * a grant can cover extra folders (`extraFoldersWritable`), Review only
   * included: making one editable there is how a session leaves it.
   */
  onToggleExtraWritable?: (folder: string, writable: boolean) => void
  /**
   * Whether the user marked the main folder read-only under Edit this
   * folder; the other folders keep their own marks. Ignored in a worktree.
   */
  mainFolderReadOnly?: boolean
  /** Toggle the main folder between editable and read-only, like an extra. */
  onToggleMainWritable?: (writable: boolean) => void
  /** Pick another folder to attach beside the primary one. */
  onAddExtra?: () => void
  onRemoveExtra?: (folder: string) => void
  /**
   * Offer a starting FLINT.md for the folder, labelled as given ("Describe
   * this project", or continuing a saved draft). Absent when the folder
   * already has one.
   */
  describeProject?: { label: string; onOpen: () => void }
  /** `pill` in a composer row; `quiet` in the row under the composer. */
  variant?: 'pill' | 'quiet'
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
  readOnlyExtraFolders = [],
  onToggleExtraWritable,
  mainFolderReadOnly = false,
  onToggleMainWritable,
  onAddExtra,
  onRemoveExtra,
  describeProject,
  variant = 'pill',
}: Props) {
  const quiet = variant === 'quiet'
  const { t } = useTranslation()
  const shortName = useComposerCollapsed('folderName')
  const chipText = useComposerCollapsed('chipText')
  const [open, setOpen] = useState(false)
  const serviceHub = useServiceHub()
  const folderName = folder ? basenameOf(folder) : null
  const {
    primaryAccess,
    extraAccess,
    canToggleExtras,
    canToggleMain,
    writesKind,
  } = workspaceAccess({
    access,
    extraFolders,
    extraFoldersWritable,
    readOnlyExtraFolders,
    mainFolderReadOnly,
    canToggleExtraWritable: !!onToggleExtraWritable,
    canToggleMainWritable: !!onToggleMainWritable,
  })
  const TriggerIcon = ACCESS_BADGE[primaryAccess].icon

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={folderName && !quiet ? 'outline' : 'ghost'}
          size={folderName ? 'xs' : 'icon-xs'}
          data-variant={variant}
          className={
            quiet
              ? folderName
                ? // Like the access and mode buttons beside it under the composer.
                  'group/ws h-7 min-w-0 max-w-48 shrink gap-2 overflow-hidden px-2 text-xs font-medium text-muted-foreground pointer-coarse:h-11'
                : 'size-7 shrink-0 text-muted-foreground pointer-coarse:size-11'
              : folderName
              ? 'group/ws h-[30px] min-w-[2.125rem] shrink justify-start gap-2 overflow-hidden px-2.5 text-xs font-medium text-muted-foreground pointer-coarse:h-11'
              : 'size-[30px] shrink-0 text-muted-foreground pointer-coarse:size-11'
          }
          title={folderName && (shortName || chipText) ? folderName : undefined}
          data-collapsed={folderName && (shortName || chipText) ? 'true' : undefined}
          aria-label={
            folderName
              ? t(
                  primaryAccess === 'editable'
                    ? 'common:workspace.a11yWithFolderEditable'
                    : primaryAccess === 'worktree'
                      ? 'common:workspace.a11yWithFolderWorktree'
                      : 'common:workspace.a11yWithFolder',
                  { folder: folderName }
                )
              : t('common:workspace.a11yNoFolder')
          }
        >
          {folderName ? (
            <>
              {/* The folder icon and its name; a long name fades, it is not
                  cut with an ellipsis. The branch is in the tooltips. */}
              <Folder className="size-3.5 shrink-0" aria-hidden />
              {!chipText && (
                <FadeText
                  data-folder-name
                  title={gitBranch ? `${folderName} · ${gitBranch}` : folderName}
                  className="min-w-[3ch] max-w-[120px] shrink-[4] overflow-hidden whitespace-nowrap text-secondary-foreground"
                >
                  {folderName}
                </FadeText>
              )}
              {extraFolders.length > 0 ? (
                <span aria-hidden className="font-normal text-muted-foreground">
                  +{extraFolders.length}
                </span>
              ) : null}
              {/* At most one trailing mark at rest. A worktree is a quiet
                  badge past a thin divider; editing in place shows its pencil
                  only on hover or focus; read-only keeps its lock. */}
              {primaryAccess === 'worktree' ? (
                <span
                  data-worktree-badge
                  title={
                    gitBranch
                      ? t('common:workspace.worktreeBadge', { branch: gitBranch })
                      : t('common:workspace.worktreeBadgeNoBranch')
                  }
                  className="flex shrink-0 items-center gap-2"
                >
                  <span aria-hidden className="h-3.5 w-px bg-border" />
                  <GitFork className="size-3.5 text-muted-foreground" aria-hidden />
                </span>
              ) : (
                <TriggerIcon
                  className={
                    primaryAccess === 'editable'
                      ? 'size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/ws:opacity-100 group-focus-visible/ws:opacity-100'
                      : 'size-3.5 shrink-0 text-muted-foreground'
                  }
                  aria-hidden
                  data-access={primaryAccess}
                />
              )}
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
              <p className="text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                {t('common:workspace.readsFrom')}
              </p>
              <div className="mt-1.5 flex items-start gap-2">
                <Folder
                  size={15}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold">
                    {folderName}
                  </p>
                  <p
                    className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                    title={folder}
                  >
                    {truncateMiddle(folder, 40)}
                  </p>
                </div>
                {canToggleMain ? (
                  <AccessToggle
                    kind={primaryAccess}
                    size={10}
                    folderName={folderName}
                    onToggle={(writable) => onToggleMainWritable?.(writable)}
                    mainToggle
                  />
                ) : (
                  <AccessBadge kind={primaryAccess} size={10} />
                )}
              </div>
              {gitBranch && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch size={12} aria-hidden />
                  <span className="sr-only">
                    {t('common:workspace.branchLabel')}:{' '}
                  </span>
                  <FadeText className="font-mono">{gitBranch}</FadeText>
                </p>
              )}
            </section>

            {/* Folders attached beside the primary one. Each is treated like
                it; the shell still starts in the primary. */}
            {extraFolders.length > 0 || onAddExtra ? (
              <ExtraFoldersSection
                extraFolders={extraFolders}
                extraAccess={extraAccess}
                canToggleExtras={canToggleExtras}
                onToggleExtraWritable={onToggleExtraWritable}
                onAddExtra={onAddExtra}
                onRemoveExtra={onRemoveExtra}
              />
            ) : null}

            <Separator className="my-0.5 bg-transparent border-t border-dashed border-border" />

            <WritesToSection
              writesKind={writesKind}
              workspacePath={workspacePath}
            />

            <Separator className="my-0.5 bg-transparent border-t border-dashed border-border" />

            {/* Reaching the folder */}
            <section className="flex flex-wrap gap-1.5 p-1.5">
              <Button
                variant="surface"
                size="sm"
                className="flex-1"
                onClick={() => void serviceHub.opener().openPath(folder, [folder, ...(extraFolders ?? [])])}
              >
                <FolderOpen size={14} aria-hidden />
                {t('common:workspace.open')}
              </Button>
              <Button
                variant="surface"
                size="sm"
                className="flex-1"
                onClick={() => void serviceHub.opener().revealItemInDir(folder, [folder, ...(extraFolders ?? [])])}
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
              {describeProject ? (
                <Button
                  variant="surface"
                  size="sm"
                  className="w-full"
                  data-testid="project-init-open"
                  onClick={() => {
                    // The dialog outlives this menu, so the menu goes first.
                    setOpen(false)
                    describeProject.onOpen()
                  }}
                >
                  <FileText size={14} aria-hidden />
                  {describeProject.label}
                </Button>
              ) : null}
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
              {t(
                access === 'review-only'
                  ? 'common:workspace.footnoteEmpty'
                  : 'common:workspace.footnoteEmptyEdit'
              )}
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
