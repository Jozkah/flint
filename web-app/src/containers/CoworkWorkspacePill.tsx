import {
  Box,
  Copy,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Lock,
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

type Props = {
  /** Attached project folder, or null when the session is sandbox-only. */
  folder: string | null
  /** The session sandbox writes land in; null until it has been created. */
  workspacePath?: string | null
  gitBranch?: string | null
  onAttach: () => void
  onDetach: () => void
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
}: Props) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const folderName = folder ? basenameOf(folder) : null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={folderName ? 'xs' : 'icon-xs'}
          className="shrink-0 text-muted-foreground"
          aria-label={
            folderName
              ? t('common:workspace.a11yWithFolder', { folder: folderName })
              : t('common:workspace.a11yNoFolder')
          }
        >
          {folderName ? (
            <>
              <Folder className="size-3.5 shrink-0" />
              <span className="max-w-[120px] truncate text-foreground">
                {folderName}
              </span>
              <Lock className="size-3 shrink-0 text-muted-foreground/70" />
            </>
          ) : (
            <FolderPlus className="size-[18px] shrink-0" />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        // Narrow windows: never wider than the viewport, and never taller
        // than the space above the composer it is anchored to.
        className="w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(28rem,60vh)] overflow-y-auto p-0"
        aria-label={t('common:workspace.actionsLabel')}
      >
        {folder ? (
          <>
            {/* What is attached */}
            <section className="p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('common:workspace.readsFrom')}
              </p>
              <div className="mt-1.5 flex items-start gap-2">
                <Folder
                  size={15}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{folderName}</p>
                  <p
                    className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                    title={folder}
                  >
                    {truncateMiddle(folder, 40)}
                  </p>
                </div>
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  title={t('common:workspace.footnote')}
                >
                  <Lock size={10} aria-hidden />
                  {t('common:workspace.readOnly')}
                </span>
              </div>
              {gitBranch && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch size={12} aria-hidden />
                  <span className="sr-only">
                    {t('common:workspace.branchLabel')}:{' '}
                  </span>
                  <span className="truncate font-mono">{gitBranch}</span>
                </p>
              )}
            </section>

            <Separator />

            {/* Where the agent's changes actually land. The folder above is
                read-only, so saying "writable project" would be a lie. */}
            <section className="p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('common:workspace.writesTo')}
              </p>
              <div className="mt-1.5 flex items-start gap-2">
                <Box
                  size={15}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {t('common:workspace.sandbox')}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {workspacePath
                      ? t('common:workspace.sandboxNote')
                      : t('common:workspace.sandboxPending')}
                  </p>
                </div>
              </div>
            </section>

            <Separator />

            {/* Reaching the folder */}
            <section className="flex flex-wrap gap-1 p-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 flex-1"
                onClick={() => void serviceHub.opener().openPath(folder)}
              >
                <FolderOpen size={14} aria-hidden />
                {t('common:workspace.open')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 flex-1"
                onClick={() => void serviceHub.opener().revealItemInDir(folder)}
              >
                <ExternalLink size={14} aria-hidden />
                {t('common:workspace.reveal')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 flex-1"
                onClick={() => void navigator.clipboard?.writeText(folder)}
              >
                <Copy size={14} aria-hidden />
                {t('common:workspace.copyPath')}
              </Button>
            </section>

            <Separator />

            {/* Changing the attachment. Detaching is the disruptive one, so it
                sits apart from the rest rather than beside them. */}
            <section className="flex items-center gap-2 p-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onAttach}
              >
                {t('common:workspace.change')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onDetach}
              >
                {t('common:workspace.detach')}
              </Button>
            </section>
          </>
        ) : (
          <section className="p-3">
            <p className="text-xs text-muted-foreground">
              {t('common:workspace.footnoteEmpty')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 h-8 w-full"
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
