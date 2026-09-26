import { useEffect, useState } from 'react'
import { Settings2, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { BlameCommit, ChangeHunk } from '@/lib/codeGutter'
import { loadCommitPr } from '@/lib/coworkGit'
import { useCodeOverlaySettings } from '@/hooks/useCodeGitOverlays'

/** The panel's settings menu: the two overlay toggles. */
export function CodeOverlayMenu() {
  const { t } = useTranslation()
  const { changeMarkers, inlineBlame, set } = useCodeOverlaySettings()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('common:codePanel.settings')}
          title={t('common:codePanel.settings')}
          className="shrink-0 text-muted-foreground pointer-coarse:size-11"
        >
          <Settings2 className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={changeMarkers}
          onCheckedChange={(v) => set({ changeMarkers: !!v })}
        >
          {t('common:codePanel.changeMarkers')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={inlineBlame}
          onCheckedChange={(v) => set({ inlineBlame: !!v })}
        >
          {t('common:codePanel.inlineBlame')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The card shown while hovering the blame annotation. */
export function BlameCard({
  commit,
  anchor,
  root,
  webUrl,
  onEnter,
  onLeave,
}: {
  commit: BlameCommit
  anchor: DOMRect
  root: string
  webUrl: string | null
  onEnter: () => void
  onLeave: () => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [pr, setPr] = useState<{ number: number; url: string } | null>(null)
  useEffect(() => {
    setPr(null)
    if (commit.uncommitted || !webUrl) return
    let alive = true
    void loadCommitPr(root, commit.sha).then((found) => alive && setPr(found))
    return () => {
      alive = false
    }
  }, [root, commit.sha, commit.uncommitted, webUrl])
  const open = (url: string) => void serviceHub.opener().openUrl(url)
  return (
    <div
      role="tooltip"
      data-testid="blame-card"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'fixed',
        top: anchor.bottom + 4,
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - 328)),
      }}
      className="z-50 w-80 rounded-lg border-[0.8px] border-border bg-popover p-3 text-xs text-foreground shadow-pop"
    >
      {commit.uncommitted ? (
        <p>{t('common:codePanel.notCommitted')}</p>
      ) : (
        <>
          <p className="font-medium">{commit.author}</p>
          <p className="text-muted-foreground">
            {new Date(commit.time * 1000).toLocaleString()}
          </p>
          <p className="mt-2 whitespace-pre-wrap">{commit.summary}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-muted-foreground">
            {webUrl ? (
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => open(`${webUrl}/commit/${commit.sha}`)}
              >
                {commit.sha.slice(0, 7)}
              </button>
            ) : (
              <span>{commit.sha.slice(0, 7)}</span>
            )}
            {pr && (
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => open(pr.url)}
              >
                {t('common:codePanel.pullRequest', { number: pr.number })}
              </button>
            )}
          </p>
        </>
      )}
    </div>
  )
}

/** The inline diff of one clicked change marker, with Revert. */
export function HunkPopover({
  hunk,
  onRevert,
  onClose,
}: {
  hunk: ChangeHunk
  onRevert: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="dialog"
      aria-label={t('common:codePanel.changeAt', { line: hunk.start })}
      data-testid="hunk-popover"
      className="absolute inset-x-3 top-2 z-20 max-h-[45%] overflow-auto rounded-lg border-[0.8px] border-border bg-popover font-mono text-xs shadow-pop"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="flex items-center gap-1 border-b border-dashed border-border px-2 py-1 font-sans">
        <span className="flex-1 text-muted-foreground">
          {t('common:codePanel.changeAt', { line: hunk.start })}
        </span>
        <Button size="xs" variant="ghost" onClick={onRevert} autoFocus>
          <Undo2 className="size-3" />
          {t('common:codePanel.revertChange')}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('common:close')}
          onClick={onClose}
        >
          <X className="size-3" />
        </Button>
      </div>
      <div className="py-1">
        {hunk.oldLines.map((line, i) => (
          <div key={`o${i}`} className="bg-diff-del-bg px-2 whitespace-pre text-diff-del">
            - {line}
          </div>
        ))}
        {hunk.newLines.map((line, i) => (
          <div key={`n${i}`} className="bg-diff-add-bg px-2 whitespace-pre text-diff-add">
            + {line}
          </div>
        ))}
      </div>
    </div>
  )
}
