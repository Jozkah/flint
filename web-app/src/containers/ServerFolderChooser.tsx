import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, CornerLeftUp, Folder, GitBranch } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { useSmallScreen } from '@/hooks/useMediaQuery'
import { listAgentFolders, type FolderListing } from '@/lib/remoteRunner'
import { runnerInfo } from '@/lib/remoteCowork'
import { displayPath, useServerFolderPicker } from '@/lib/serverFolderPicker'
import { cn } from '@/lib/utils'

type Phase =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; listing: FolderListing }

/**
 * Browse the folders the server allows and report the one in view. Roots
 * first; a root's parent is never offered. Keyboard: arrows move, Enter or
 * Right opens a folder, Left or Backspace goes up.
 */
export function ServerFolderBrowser({
  onChange,
  className,
}: {
  /** The folder in view (null at the list of roots) and whether it is a repository. */
  onChange: (path: string | null, git: boolean) => void
  className?: string
}) {
  const { t } = useTranslation()
  const [path, setPath] = useState<string | null>(null)
  const [git, setGit] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const listRef = useRef<HTMLUListElement>(null)
  // The last folder that listed (null: the roots): where Up goes from a folder
  // that failed to open, so the user is never stuck on the error (W03).
  const lastListed = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    setPhase({ kind: 'loading' })
    void (async () => {
      try {
        if (path === null) {
          const info = await runnerInfo().catch(() => null)
          if (!info?.agent) {
            if (live) setPhase({ kind: 'off' })
            return
          }
        }
        const listing = await listAgentFolders(path)
        if (live) {
          lastListed.current = path
          setPhase({ kind: 'ready', listing })
        }
      } catch (e) {
        if (live) setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      live = false
    }
  }, [path])

  useEffect(() => {
    onChange(path, git)
  }, [path, git, onChange])

  const go = useCallback((next: string | null, nextGit = false) => {
    setPath(next)
    setGit(nextGit)
  }, [])

  const parent = phase.kind === 'ready' ? phase.listing.parent : null
  const goUp = () => go(parent ?? null)

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-folder-item]') ?? []
    )
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[Math.max(0, Math.min(items.length - 1, at + step))]?.focus()
    } else if (e.key === 'ArrowRight' && at >= 0) {
      e.preventDefault()
      items[at].click()
    } else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && path !== null) {
      e.preventDefault()
      goUp()
    }
  }

  // Focus the first folder once a listing arrives, so the keyboard can start.
  useEffect(() => {
    if (phase.kind !== 'ready') return
    listRef.current?.querySelector<HTMLButtonElement>('button[data-folder-item]')?.focus()
  }, [phase])

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)} data-testid="server-folder-browser">
      <p className="truncate text-xs text-muted-foreground" title={path ? displayPath(path) : undefined}>
        {path ? displayPath(path) : t('integrations:serverFolders.roots')}
      </p>
      {phase.kind === 'off' && (
        <p className="rounded border border-dashed p-3 text-sm" data-testid="server-folder-off">
          {t('integrations:serverFolders.off')}
        </p>
      )}
      {phase.kind === 'loading' && (
        <p className="p-3 text-sm text-muted-foreground">{t('integrations:serverFolders.loading')}</p>
      )}
      {phase.kind === 'error' && (
        <>
          <p className="p-3 text-sm text-destructive" role="alert">
            {phase.message}
          </p>
          {path !== null && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded border px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
              onClick={() => go(lastListed.current === path ? null : lastListed.current)}
              data-testid="server-folder-up"
            >
              <CornerLeftUp className="size-4 shrink-0" aria-hidden />
              {t('integrations:serverFolders.up')}
            </button>
          )}
        </>
      )}
      {phase.kind === 'ready' && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={t('integrations:serverFolders.title')}
          className="min-h-0 flex-1 overflow-auto rounded border"
          onKeyDown={onKeyDown}
        >
          {path !== null && (
            <li>
              <button
                type="button"
                data-folder-item
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={goUp}
                data-testid="server-folder-up"
              >
                <CornerLeftUp className="size-4 shrink-0" aria-hidden />
                {t('integrations:serverFolders.up')}
              </button>
            </li>
          )}
          {phase.listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-folder-item
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={() => go(entry.path, entry.git)}
                data-testid="server-folder-entry"
              >
                <Folder className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {path === null ? displayPath(entry.path) : entry.name}
                </span>
                {entry.git && <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-label="git" />}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
          {phase.listing.entries.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {t('integrations:serverFolders.empty')}
            </li>
          )}
          {phase.listing.truncated && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {t('integrations:serverFolders.truncated')}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * A dialog on wide screens and a bottom sheet on phones; the same body in both.
 */
export function ResponsiveSheet({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  testId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  footer: React.ReactNode
  children: React.ReactNode
  testId?: string
}) {
  const small = useSmallScreen()
  if (small) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[85dvh]" data-testid={testId}>
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4">{children}</div>
          <DrawerFooter>{footer}</DrawerFooter>
        </DrawerContent>
      </Drawer>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Renders the chooser `pickServerFolder()` asks for. Mounted once per page. */
export function ServerFolderPickerHost() {
  const { t } = useTranslation()
  const open = useServerFolderPicker((s) => s.open)
  const settle = useServerFolderPicker((s) => s.settle)
  const [current, setCurrent] = useState<string | null>(null)
  const onChange = useCallback((path: string | null) => setCurrent(path), [])
  if (!open) return null
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => !next && settle(null)}
      title={t('integrations:serverFolders.title')}
      description={t('integrations:serverFolders.description')}
      testId="server-folder-picker"
      footer={
        <>
          <Button variant="outline" onClick={() => settle(null)}>
            {t('common:cancel')}
          </Button>
          <Button
            disabled={!current}
            onClick={() => settle(current)}
            data-testid="server-folder-choose"
          >
            {t('integrations:serverFolders.choose')}
          </Button>
        </>
      }
    >
      <ServerFolderBrowser onChange={onChange} className="h-[50dvh] sm:h-80" />
    </ResponsiveSheet>
  )
}
