import { ChevronDown, FolderOpen, SquareArrowOutUpRight } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Card } from '@/components/ui/card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { resolveInRoot } from '@/lib/coworkPreview'
import { ARTIFACT_ICON, type CoworkArtifact } from '@/lib/coworkArtifacts'

/**
 * Inline card for something the agent produced (jan-internal #242).
 *
 * Rendered by the Cowork transcript itself rather than by `MessageItem`, which
 * is shared with the chat surface — the association is derived from a message's
 * own write/edit parts, so nothing shared needs to know artifacts exist.
 *
 * Card body opens the in-app preview; the split button hands the file to the OS.
 */
export function CoworkArtifactCard({
  artifact,
  root,
  onPreview,
}: {
  artifact: CoworkArtifact
  root: string | null
  onPreview: (path: string) => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const Icon = ARTIFACT_ICON[artifact.group]
  const abs = root ? resolveInRoot(root, artifact.path) : null

  return (
    <Card className="my-2 flex flex-row items-center gap-3 rounded-xl border-[0.8px] p-2.5 shadow-none transition-shadow duration-200 hover:shadow-lift motion-safe:animate-rise-in">
      <button
        type="button"
        onClick={() => onPreview(artifact.path)}
        title={t('common:artifactOpenPreview')}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-muted shadow-[inset_0_0_0_0.8px_var(--border)]">
          <Icon size={18} className="text-secondary-foreground" />
        </span>
        <span className="min-w-0">
          <span
            className="block truncate text-[13px] font-semibold"
            title={artifact.title}
          >
            {artifact.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {artifact.group} · {artifact.label}
          </span>
        </span>
      </button>

      {abs && (
        <div className="flex shrink-0 items-center rounded-lg border-[0.8px] border-border bg-card">
          <button
            type="button"
            onClick={() => void serviceHub.opener().openPath(abs, root ? [root] : [])}
            className="flex h-7 items-center gap-1.5 rounded-l-lg px-2.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-hover-btn hover:text-foreground"
          >
            <SquareArrowOutUpRight size={13} className="text-muted-foreground" />
            {t('common:artifactOpenExternal')}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('common:artifactMoreActions')}
                className="grid h-7 w-[26px] place-items-center rounded-r-lg border-l-[0.8px] border-border transition-colors hover:bg-hover-btn"
              >
                <ChevronDown size={13} className="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void serviceHub.opener().openPath(abs, root ? [root] : [])}>
                <SquareArrowOutUpRight size={14} />
                {t('common:artifactOpenExternal')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void serviceHub.opener().revealItemInDir(abs, root ? [root] : [])}>
                <FolderOpen size={14} />
                {t('common:artifactShowInFolder')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </Card>
  )
}
