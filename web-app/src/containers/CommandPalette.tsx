/**
 * One palette for navigation, session actions and settings. AH-206.
 *
 * Opened from anywhere with the Command Palette shortcut (Ctrl/Cmd+Shift+P by
 * default, rebindable in Settings → Shortcuts). Entries come from the app's
 * own routes, the settings registry and the conversation list, and are ranked
 * locally (`rankCommands`); nothing is looked up over the network.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useNavigate } from '@tanstack/react-router'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Search } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from '@/hooks/useThreads'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { SETTINGS_PAGES } from '@/lib/settingsSearch'
import {
  rankCommands,
  type PaletteCommand,
  type PaletteSection,
} from '@/lib/commandPalette'
import { cn } from '@/lib/utils'

type PaletteState = {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useCommandPalette = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

export function CommandPalette() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const open = useCommandPalette((s) => s.open)
  const setOpen = useCommandPalette((s) => s.setOpen)
  const threads = useThreads((s) => s.threads)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = (to: string, params?: Record<string, string>) => () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigate({ to, params } as any)
    const out: PaletteCommand[] = [
      {
        id: 'action-new-chat',
        section: 'actions',
        title: t('common:commandPalette.newChat'),
        keywords: ['conversation', 'thread'],
        run: () => {
          useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
          navigate({ to: route.home })
        },
      },
      {
        id: 'action-new-project',
        section: 'actions',
        title: t('common:commandPalette.newProject'),
        run: () => useProjectDialog.getState().setOpen(true),
      },
      {
        id: 'action-search-threads',
        section: 'actions',
        title: t('common:commandPalette.searchThreads'),
        keywords: ['find', 'history'],
        run: () => useSearchDialog.getState().setOpen(true),
      },
      {
        id: 'action-toggle-sidebar',
        section: 'actions',
        title: t('common:commandPalette.toggleSidebar'),
        run: () => {
          const panel = useLeftPanel.getState()
          panel.setLeftPanel(!panel.open)
        },
      },
      {
        id: 'nav-cowork',
        section: 'navigation',
        title: t('common:commandPalette.openCowork'),
        keywords: ['agent', 'workspace'],
        run: go(route.cowork),
      },
      {
        id: 'nav-artifacts',
        section: 'navigation',
        title: t('common:commandPalette.openArtifacts'),
        run: go(route.artifacts),
      },
      {
        id: 'nav-system-monitor',
        section: 'navigation',
        title: t('common:commandPalette.openSystemMonitor'),
        keywords: ['hardware', 'gpu', 'memory'],
        run: go(route.systemMonitor),
      },
      {
        id: 'nav-logs',
        section: 'navigation',
        title: t('common:commandPalette.openLogs'),
        run: go(route.appLogs),
      },
    ]
    for (const page of SETTINGS_PAGES) {
      out.push({
        id: `settings-${page.id}`,
        section: 'settings',
        title: t(page.titleKey),
        hint: t('common:settings'),
        keywords: [...(page.keywords ?? [])],
        run: go(page.route),
      })
    }
    const recent = Object.values(threads ?? {})
      .filter((thread) => thread.id !== TEMPORARY_CHAT_ID)
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    for (const thread of recent) {
      out.push({
        id: `thread-${thread.id}`,
        section: 'threads',
        title: thread.title || t('common:commandPalette.untitled'),
        run: go(route.threadsDetail, { threadId: thread.id }),
      })
    }
    return out
  }, [t, navigate, threads])

  const results = useMemo(
    () => rankCommands(commands, query),
    [commands, query]
  )

  useEffect(() => {
    setActive(0)
  }, [query])

  const runAt = (index: number) => {
    const command = results[index]
    if (!command) return
    setOpen(false)
    command.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(active)
    }
  }

  const sectionLabel = (section: PaletteSection) =>
    t(`common:commandPalette.section.${section}`)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // Phone: a full-screen sheet rather than a bottom sheet under the
        // keyboard.
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-xl sm:pb-0 max-sm:top-0 max-sm:h-(--app-vvh,100dvh) max-sm:max-h-none max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="command-palette"
      >
        <VisuallyHidden>
          <DialogTitle>{t('common:commandPalette.title')}</DialogTitle>
        </VisuallyHidden>
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('common:commandPalette.placeholder')}
            className="h-12 min-w-0 flex-1 bg-transparent px-2 text-base placeholder:text-muted-foreground focus:outline-none md:text-sm"
            data-testid="command-palette-input"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-activedescendant={
              results[active] ? `palette-${results[active].id}` : undefined
            }
          />
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="h-11 sm:hidden">
              {t('common:cancel')}
            </Button>
          </DialogClose>
        </div>
        <ul
          id="command-palette-list"
          role="listbox"
          aria-label={t('common:commandPalette.title')}
          className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 sm:max-h-80 sm:flex-none"
        >
          {results.length === 0 ? (
            <li
              role="presentation"
              className="px-3 py-6 text-center text-sm text-muted-foreground"
            >
              {t('common:commandPalette.empty')}
            </li>
          ) : null}
          {results.map((command, index) => {
            // Ranking decides the order; a label marks where a run of one
            // section starts, so keyboard order and visual order stay one.
            const startsGroup =
              index === 0 || results[index - 1].section !== command.section
            const selected = index === active
            return (
              <Fragment key={command.id}>
                {startsGroup && (
                  <li
                    role="presentation"
                    className="px-3 pb-0.5 pt-2 text-xs font-medium tracking-wide text-muted-foreground [font-variant-caps:all-small-caps]"
                  >
                    {t(`common:commandPalette.group.${command.section}`)}
                  </li>
                )}
                <li
                  id={`palette-${command.id}`}
                  role="option"
                  aria-selected={selected}
                  data-testid="command-palette-item"
                  data-command={command.id}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => runAt(index)}
                  className={cn(
                    'relative flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm pointer-coarse:min-h-11',
                    selected &&
                      'bg-brand-tint before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {command.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {command.hint ?? sectionLabel(command.section)}
                  </span>
                </li>
              </Fragment>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
