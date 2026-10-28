/* eslint-disable react-refresh/only-export-components */
/**
 * One palette for navigation, session actions and settings. AH-206.
 *
 * Opened from anywhere with the Command Palette shortcut (Ctrl/Cmd+Shift+P by
 * default, rebindable in Settings → Shortcuts). Entries come from the app's
 * own routes, the settings registry and the conversation list, and are ranked
 * locally (`rankCommands`); nothing is looked up over the network.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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
import {
  SETTINGS_PAGES,
  isSettingsPageAvailable,
} from '@/lib/settingsSearch'
import { SIDEBAR_ITEMS, isNavItemAvailable, isSidebarItemHidden } from '@/lib/sidebarItems'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { runExport } from '@/lib/exportAction'
import { docFromCowork, docFromThread } from '@/lib/exportDoc'
import {
  exportCommands,
  rankCommands,
  type PaletteCommand,
  type PaletteSection,
} from '@/lib/commandPalette'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/ui/icon'

/** The design's row marks: actions, places, settings, conversations. */
const SECTION_ICON: Record<PaletteSection, IconName> = {
  actions: 'zap',
  navigation: 'arrow-up',
  settings: 'sb-settings',
  threads: 'comment',
}

type PaletteState = {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useCommandPalette = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

const NO_THREADS: ReturnType<typeof useThreads.getState>['threads'] = {}

const MAX_RESULTS_QUERY = 50
const MAX_RESULTS_EMPTY = 200

export function CommandPalette() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const open = useCommandPalette((s) => s.open)
  const setOpen = useCommandPalette((s) => s.setOpen)
  // Read only while it is needed: with thousands of chats every title or
  // timestamp change would otherwise re-render this while it is hidden.
  const threads = useThreads((s) => (open ? s.threads : NO_THREADS))
  const hiddenNavItems = useInterfaceSettings((s) => s.hiddenNavItems)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

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
        id: 'nav-rooms',
        section: 'navigation',
        title: t('common:commandPalette.openItem', {
          item: t('common:appRail.rooms'),
        }),
        keywords: ['compare', 'models', 'discussion'],
        run: go(route.rooms),
      },
      {
        id: 'nav-artifacts',
        section: 'navigation',
        title: t('common:commandPalette.openArtifacts'),
        run: go(route.artifacts),
      },
      {
        id: 'nav-studio',
        section: 'navigation',
        title: t('common:commandPalette.openStudio'),
        keywords: ['image', 'video', 'generate', 'picture', 'draw'],
        run: go(route.studio),
      },
      {
        id: 'nav-archive',
        section: 'navigation',
        title: t('archive:open'),
        keywords: ['deleted', 'restore', 'trash', 'bin'],
        run: go(route.archive),
      },
      {
        id: 'nav-system-monitor',
        section: 'navigation',
        title: t('common:commandPalette.openSystemMonitor'),
        keywords: ['hardware', 'gpu', 'cpu', 'memory', 'vram'],
        run: go(route.systemMonitor),
      },
      {
        id: 'nav-logs',
        section: 'navigation',
        title: t('common:commandPalette.openLogs'),
        run: go(route.appLogs),
      },
    ]
    // The browser `flint serve` serves does not offer desktop-only pages.
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].id.startsWith('nav-') && !isNavItemAvailable(out[i].id.slice(4))) out.splice(i, 1)
    }
    // Anything the sidebar can hide stays one palette entry away.
    const listed = new Set(out.map((c) => c.id))
    for (const item of SIDEBAR_ITEMS) {
      const id = `nav-${item.id}`
      if (!item.canHide || listed.has(id) || item.id === 'library') continue
      if (!isNavItemAvailable(item.id)) continue
      out.push({
        id,
        section: 'navigation',
        title: t('common:commandPalette.openItem', { item: t(item.labelKey) }),
        run: go(item.to()),
      })
    }
    // Show or hide any page in the sidebar from here, so a trimmed sidebar is
    // one search away from being put back.
    for (const item of SIDEBAR_ITEMS) {
      if (!item.canHide) continue
      const label = t(item.labelKey)
      const isHidden = isSidebarItemHidden(hiddenNavItems, item.id)
      out.push({
        id: `sidebar-toggle-${item.id}`,
        section: 'settings',
        title: isHidden
          ? t('settings:sidebarItems.showItem', { item: label })
          : t('settings:sidebarItems.hideItem', { item: label }),
        keywords: ['sidebar', 'pin'],
        run: () =>
          useInterfaceSettings.getState().setNavItemHidden(item.id, !isHidden),
      })
    }
    // What is on screen decides whether there is anything to export.
    const path = typeof window === 'undefined' ? '' : window.location.pathname
    const threadId = /\/threads\/([^/?#]+)/.exec(path)?.[1] ?? null
    const target = threadId
      ? 'thread'
      : path.startsWith(route.cowork)
        ? 'session'
        : null
    out.push(
      ...exportCommands(
        target,
        (format) => t(`common:export.command.${format}`),
        (kind, format) => {
          const choice = { format, view: 'default' as const }
          if (kind === 'thread' && threadId) {
            void runExport(
              async () => {
                const { useMessages } = await import('@/hooks/useMessages')
                const thread = useThreads.getState().threads[threadId]
                return docFromThread(
                  thread ?? { id: threadId },
                  useMessages.getState().getMessages(threadId),
                  new Date()
                )
              },
              choice,
              t
            )
          } else {
            void runExport(
              async () => {
                const { useCoworkSessions } = await import(
                  '@/hooks/useCoworkSessions'
                )
                const state = useCoworkSessions.getState()
                const session = state.sessions.find(
                  (s) => s.id === state.currentId
                )
                return session ? docFromCowork(session, new Date()) : null
              },
              choice,
              t
            )
          }
        }
      )
    )
    for (const page of SETTINGS_PAGES) {
      if (!isSettingsPageAvailable(page.id)) continue
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
  }, [t, navigate, threads, open, hiddenNavItems])

  // Ranking every conversation per keystroke is cheap, rendering them all is
  // not: show the best 50 for a query, 200 for the empty one.
  const results = useMemo(
    () =>
      rankCommands(commands, query).slice(
        0,
        query.trim() ? MAX_RESULTS_QUERY : MAX_RESULTS_EMPTY
      ),
    [commands, query]
  )
  const groups = useMemo(() => {
    const out: Array<{
      section: PaletteSection
      items: Array<{ command: (typeof results)[number]; index: number }>
    }> = []
    results.forEach((command, index) => {
      const last = out[out.length - 1]
      if (last && last.section === command.section) {
        last.items.push({ command, index })
      } else {
        out.push({ section: command.section, items: [{ command, index }] })
      }
    })
    return out
  }, [results])

  useEffect(() => {
    setActive(0)
  }, [query])

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    const id = results[active]?.id
    if (!id) return
    document.getElementById(`palette-${id}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, results])

  const runAt = (index: number) => {
    const command = results[index]
    if (!command) return
    setOpen(false)
    command.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // An IME confirming a candidate (Enter) or moving through its candidate
    // list (arrows) is not a palette command.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
        className="flex flex-col gap-0 overflow-hidden rounded-[14px] bg-popover p-0 sm:max-w-[560px] lg:max-w-[560px] xl:max-w-[560px] sm:pb-0 max-sm:top-0 max-sm:h-(--app-vvh,100dvh) max-sm:max-h-none max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="command-palette"
        onOpenAutoFocus={() => {
          // Where focus was before opening, so closing can put it back even
          // when a shortcut opened this rather than a trigger button.
          const active = document.activeElement
          restoreRef.current = active instanceof HTMLElement ? active : null
        }}
        onCloseAutoFocus={(event) => {
          const el = restoreRef.current
          restoreRef.current = null
          if (el && el.isConnected && el !== document.body) {
            event.preventDefault()
            el.focus({ preventScroll: true })
          }
        }}
      >
        <VisuallyHidden>
          <DialogTitle>{t('common:commandPalette.title')}</DialogTitle>
        </VisuallyHidden>
        <div className="flex shrink-0 items-center gap-2.5 border-b border-dashed border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('common:commandPalette.placeholder')}
            className="h-[50px] min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none md:text-sm"
            data-testid="command-palette-input"
            role="combobox"
            aria-expanded={results.length > 0}
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
        {results.length === 0 ? (
          <div
            role="status"
            className="px-3 py-6 text-center text-sm text-muted-foreground"
          >
            {t('common:commandPalette.empty')}
          </div>
        ) : null}
        <ul
          id="command-palette-list"
          role="listbox"
          aria-label={t('common:commandPalette.title')}
          className="min-h-0 flex-1 overflow-y-auto p-1.5 sm:max-h-[50vh] sm:flex-none"
        >
          {groups.map((group, groupIndex) => {
            // Ranking decides the order; each run of one section is a labelled
            // group, so keyboard order and visual order stay one.
            const headingId = `palette-group-${groupIndex}`
            return (
              <li key={`${group.section}-${groupIndex}`} role="presentation">
                <div
                  id={headingId}
                  role="presentation"
                  className="px-2.5 pt-2 pb-1 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-subtle-foreground uppercase"
                >
                  {t(`common:commandPalette.group.${group.section}`)}
                </div>
                <ul role="group" aria-labelledby={headingId}>
                  {group.items.map(({ command, index }) => {
                    const selected = index === active
                    return (
                      <li
                        key={command.id}
                        id={`palette-${command.id}`}
                        role="option"
                        aria-selected={selected}
                        data-testid="command-palette-item"
                        data-command={command.id}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => runAt(index)}
                        className={cn(
                          'relative flex h-[34px] cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground transition-[background-color,color,transform] duration-150 ease-expo active:scale-[.96] pointer-coarse:h-11',
                          selected && 'bg-accent text-foreground'
                        )}
                      >
                        <Icon name={SECTION_ICON[command.section]} size={16} />
                        <span className="min-w-0 flex-1 truncate">
                          {command.title}
                        </span>
                        {command.hint && (
                          <span className="shrink-0 text-xs text-subtle-foreground">
                            {command.hint}
                          </span>
                        )}
                        <span className="sr-only">
                          {sectionLabel(command.section)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
