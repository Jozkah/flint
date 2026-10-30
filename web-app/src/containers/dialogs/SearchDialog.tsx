import { useConversationFind } from '@/hooks/useConversationFind'
import { useCallback, useEffect, useState, useMemo, useRef, type ReactNode } from 'react'
import { useListNavigation } from '@/hooks/useListNavigation'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Folder,
  MessagesSquare,
  Search,
  Users,
} from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { useThreads } from '@/hooks/useThreads'
import { searchMessages, type MessageHit } from '@/lib/messageSearch'
import { RichSnippet } from '@/components/RichSnippet'
import { localStorageKey } from '@/constants/localStorage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { buildPageIndex, searchPages, type PageEntry } from '@/lib/searchDialogPages'
import {
  buildSettingsIndex,
  searchSettings,
  type SettingsIndexEntry,
} from '@/lib/settingsSearch'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import { useRoomsStore } from '@/lib/rooms/store'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { searchWork, type WorkItem } from '@/lib/searchDialogWork'

const MAX_RECENT_SEARCHES = 5
/** Wait for a pause in typing before scanning every chat's messages. */
const MESSAGE_SEARCH_DEBOUNCE_MS = 250

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * A result row. The keyboard selection is the neutral selected surface with a
 * 2px accent marker, the same treatment as a selected item anywhere else.
 */
const itemClass = (selected: boolean) =>
  cn(
    'relative flex h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground transition-[background-color,color,transform] duration-150 ease-expo hover:bg-accent hover:text-foreground active:scale-[.96] pointer-coarse:h-11',
    selected && 'bg-accent text-foreground'
  )

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-subtle-foreground uppercase">
      {children}
    </span>
  )
}

const NO_THREADS: ReturnType<typeof useThreads.getState>['threads'] = {}
const NO_PROVIDERS: ReturnType<typeof useModelProvider.getState>['providers'] = []
const NO_SESSIONS: ReturnType<typeof useCoworkSessions.getState>['sessions'] = []

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [recentVersion, setRecentVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  // Read only while it is needed: with thousands of chats every title or
  // timestamp change would otherwise re-render this while it is hidden.
  const threads = useThreads((state) => (open ? state.threads : NO_THREADS))
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)

  // Full-text hits from inside the chats, fetched after typing pauses. A reply
  // for an earlier query is dropped, never shown under a newer one.
  const [messageHits, setMessageHits] = useState<MessageHit[]>([])
  useEffect(() => {
    const query = searchQuery.trim()
    if (!open || !query) {
      setMessageHits([])
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      void searchMessages(query).then((hits) => {
        if (!stale) setMessageHits(hits)
      })
    }, MESSAGE_SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [open, searchQuery])

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setSelectedIndex(0)
      setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
    }
    // setSelectedIndex is a state setter (stable), declared below with the
    // items it navigates; naming it here would read it before it exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Load recent searches from localStorage
  const recentSearches = useMemo(() => {
    if (!open) return []

    // Blocked storage (private mode, policy) must not throw during render.
    try {
      const stored = localStorage.getItem(localStorageKey.recentSearches)
      if (!stored) return []
      const threadIds = JSON.parse(stored) as string[]
      return threadIds
        .map((id) => threads[id])
        .filter((thread): thread is Thread => thread !== undefined)
        .slice(0, MAX_RECENT_SEARCHES)
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, threads, recentVersion])

  const handleClearRecent = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      localStorage.removeItem(localStorageKey.recentSearches)
    } catch {
      // Storage unavailable: nothing to clear.
    }
    setRecentVersion((v) => v + 1)
  }

  const handleClose = () => {
    setSearchQuery('')
    onOpenChange(false)
  }

  const handleSelectThread = (threadId: string, hit?: { messageId: string }) => {
    const hitQuery = searchQuery.trim()
    // Save to recent searches. Best effort: blocked storage must not stop
    // the selection from opening the thread.
    try {
      const stored = localStorage.getItem(localStorageKey.recentSearches)
      let threadIds: string[] = []

      if (stored) {
        try {
          threadIds = JSON.parse(stored) as string[]
        } catch {
          threadIds = []
        }
      }

      // Remove if already exists and add to front
      threadIds = threadIds.filter((id) => id !== threadId)
      threadIds.unshift(threadId)

      // Keep only MAX_RECENT_SEARCHES
      threadIds = threadIds.slice(0, MAX_RECENT_SEARCHES)

      localStorage.setItem(
        localStorageKey.recentSearches,
        JSON.stringify(threadIds)
      )
    } catch {
      // Recent searches are a convenience; skip them.
    }

    handleClose()
    // A hit inside a message opens the chat with the find bar on that phrase.
    if (hit && hitQuery) {
      useConversationFind
        .getState()
        .openWith({ threadId, query: hitQuery, messageId: hit.messageId })
    }
    navigate({ to: route.threadsDetail, params: { threadId } })
  }

  // Filter and group threads based on search query
  const searchResults = useMemo(() => {
    if (!searchQuery) return { withProject: [], withoutProject: [] }

    const filteredThreads = getFilteredThreads(searchQuery)
    const withProject: Array<{
      thread: Thread
      projectName: string
    }> = []
    const withoutProject: Thread[] = []

    filteredThreads.forEach((thread) => {
      const projectName = thread.metadata?.project?.name
      if (projectName) {
        withProject.push({ thread, projectName })
      } else {
        withoutProject.push(thread)
      }
    })

    return { withProject, withoutProject }
  }, [searchQuery, getFilteredThreads])

  // Pages and settings: with a minimal sidebar, this is how hidden pages
  // are reached. Ranked after chat titles, before matches inside messages.
  const providers = useModelProvider((s) => (open ? s.providers : NO_PROVIDERS))
  const pageIndex = useMemo(() => (open ? buildPageIndex(t) : []), [open, t])
  const settingsIndex = useMemo(
    () => (open ? buildSettingsIndex(t, providers) : []),
    [open, t, providers]
  )
  const pageHits = useMemo(
    () => searchPages(pageIndex, searchQuery),
    [pageIndex, searchQuery]
  )
  const settingHits = useMemo(
    () => searchSettings(settingsIndex, searchQuery, 6),
    [settingsIndex, searchQuery]
  )

  // Rooms and Cowork sessions, found by title like a chat.
  const roomSummaries = useRoomsStore((s) => s.summaries)
  // Only followed while the dialog is open: it is mounted for the window's life.
  const coworkSessions = useCoworkSessions((s) => (open ? s.sessions : NO_SESSIONS))
  useEffect(() => {
    if (open && useRoomsStore.getState().summaries.length === 0) {
      void useRoomsStore.getState().loadRooms().catch(() => {})
    }
  }, [open])
  const workHits = useMemo(() => {
    if (!open || !searchQuery.trim()) return []
    const items: WorkItem[] = [
      ...roomSummaries.map((r) => ({ kind: 'room' as const, id: r.id, title: r.title })),
      ...coworkSessions.map((c) => ({ kind: 'session' as const, id: c.id, title: c.title })),
    ]
    return searchWork(items, searchQuery)
  }, [open, searchQuery, roomSummaries, coworkSessions])

  // Calculate all selectable items for keyboard navigation
  const allItems = useMemo(() => {
    const items: Array<{
      type: 'new' | 'recent' | 'result' | 'page' | 'setting' | 'work'
      id: string
      work?: WorkItem
      page?: PageEntry
      setting?: SettingsIndexEntry
      /** The message a result stands for; Enter seeds the find bar with it. */
      hit?: (typeof messageHits)[number]
    }> = []

    if (!searchQuery) {
      // Start new chat option
      items.push({ type: 'new', id: 'new-chat' })
      // Recent searches
      recentSearches.forEach((thread) => {
        items.push({ type: 'recent', id: thread.id })
      })
    } else {
      // Search results with project
      searchResults.withProject.forEach(({ thread }) => {
        items.push({ type: 'result', id: thread.id })
      })
      // Search results without project
      searchResults.withoutProject.forEach((thread) => {
        items.push({ type: 'result', id: thread.id })
      })
      workHits.forEach((work) => {
        items.push({ type: 'work', id: `${work.kind}-${work.id}`, work })
      })
      pageHits.forEach((page) => {
        items.push({ type: 'page', id: page.id, page })
      })
      settingHits.forEach((setting) => {
        items.push({ type: 'setting', id: setting.id, setting })
      })
      // Matches inside the chats' messages
      messageHits.forEach((hit) => {
        items.push({ type: 'result', id: hit.threadId, hit })
      })
    }

    return items
  }, [searchQuery, recentSearches, searchResults, messageHits, workHits, pageHits, settingHits])

  // Scroll selected item into view
  const scrollTo = useCallback((index: number) => {
    if (listRef.current) {
      const selectedElement = listRef.current.querySelector(
        `[data-index="${index}"]`
      )
      selectedElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [])
  // Reset selected index when items change
  const {
    active: selectedIndex,
    setActive: setSelectedIndex,
    onNavKey,
  } = useListNavigation({
    count: allItems.length,
    resetKey: allItems.length,
    scrollTo,
  })

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onNavKey(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      const selectedItem = allItems[selectedIndex]
      if (selectedItem) {
        if (selectedItem.type === 'new') {
          handleStartNewChat()
        } else if (selectedItem.work) {
          openWork(selectedItem.work)
        } else if (selectedItem.page) {
          openPage(selectedItem.page)
        } else if (selectedItem.setting) {
          openSetting(selectedItem.setting)
        } else {
          handleSelectThread(selectedItem.id, selectedItem.hit)
        }
      }
    }
  }

  const openWork = (work: WorkItem) => {
    handleClose()
    if (work.kind === 'room') {
      navigate({ to: route.roomDetail, params: { roomId: work.id } })
    } else {
      useCoworkSessions.getState().selectSession(work.id)
      navigate({ to: route.cowork })
    }
  }

  const openPage = (page: PageEntry) => {
    handleClose()
    navigate({ to: page.to })
  }
  const openSetting = (entry: SettingsIndexEntry) => {
    handleClose()
    // Parked before navigating: the page's SettingTarget claims it on mount.
    if (entry.anchor) useSettingsSearch.getState().requestTarget(entry.anchor)
    navigate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry.params ? { to: entry.route, params: entry.params } : { to: entry.route }) as any
    )
  }

  const handleStartNewChat = () => {
    handleClose()
    navigate({ to: '/' })
  }

  const showStartNewChat = !searchQuery
  const hasResults =
    searchResults.withProject.length > 0 ||
    searchResults.withoutProject.length > 0 ||
    workHits.length > 0 ||
    pageHits.length > 0 ||
    settingHits.length > 0 ||
    messageHits.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Phone: a full-screen sheet, so the results are not squeezed between
        // the keyboard and a bottom sheet's top edge.
        className="flex flex-col gap-0 overflow-hidden rounded-[14px] bg-popover p-0 sm:max-w-[560px] lg:max-w-[560px] xl:max-w-[560px] sm:pb-0 max-sm:top-0 max-sm:h-(--app-vvh,100dvh) max-sm:max-h-none max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="search-dialog"
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
          <DialogTitle>{t('common:search')}</DialogTitle>
        </VisuallyHidden>

        {/* Search Input */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-dashed border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('common:searchEverything')}
            aria-label={t('common:searchEverything')}
            className="h-[50px] min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none md:text-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="h-11 sm:hidden">
              {t('common:cancel')}
            </Button>
          </DialogClose>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto p-1.5 sm:max-h-[50vh] sm:flex-none"
        >
          {/* Empty state when searching */}
          {searchQuery && !hasResults && (
            <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
              <Search className="mb-2 size-5 text-muted-foreground" />
              <h3 className="mb-1 text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">
                {t('common:noResultsFound')}
              </h3>
              <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                {t('common:noResultsFoundEverywhere')}
              </p>
            </div>
          )}

          {/* Start new chat - shown when no search query */}
          {showStartNewChat && (
            <div>
              <button
                type="button"
                data-index={0}
                data-selected={selectedIndex === 0}
                onClick={handleStartNewChat}
                className={itemClass(selectedIndex === 0)}
              >
                <Icon name="x-plus" size={16} />
                <span>{t('common:newChat')}</span>
              </button>
            </div>
          )}

          {/* Recent searches - shown when search is empty */}
          {!searchQuery && recentSearches.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
                <GroupLabel>{t('common:recents')}</GroupLabel>
                <button
                  type="button"
                  onClick={handleClearRecent}
                  className="cursor-pointer rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-11"
                >
                  {t('common:clearRecent')}
                </button>
              </div>
              {recentSearches.map((thread, index) => {
                const itemIndex = 1 + index // +1 for new chat option
                return (
                  <button
                    type="button"
                    key={thread.id}
                    data-index={itemIndex}
                    data-selected={selectedIndex === itemIndex}
                    onClick={() => handleSelectThread(thread.id)}
                    className={itemClass(selectedIndex === itemIndex)}
                  >
                    <Icon name="clock-01" size={16} />
                    <span className="truncate">{thread.title}</span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Search results with project name */}
          {searchQuery && searchResults.withProject.length > 0 && (
            <div>
              <div className="px-2.5 pt-2 pb-1">
                <GroupLabel>{t('common:searchGroup.inProjects')}</GroupLabel>
              </div>
              {searchResults.withProject.map(({ thread, projectName }, index) => {
                const itemIndex = index
                return (
                  <button
                    type="button"
                    key={thread.id}
                    data-index={itemIndex}
                    data-selected={selectedIndex === itemIndex}
                    onClick={() => handleSelectThread(thread.id)}
                    className={itemClass(selectedIndex === itemIndex)}
                  >
                    <Icon name="comment" size={16} />
                    <span className="flex min-w-0 items-center">
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Folder className="size-3" />
                        {projectName} -&nbsp;
                      </span>
                      <span className="truncate">{thread.title}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Search results without project name */}
          {searchQuery && searchResults.withoutProject.length > 0 && (
            <div>
              <div className="px-2.5 pt-2 pb-1">
                <GroupLabel>{t('common:searchGroup.conversations')}</GroupLabel>
              </div>
              {searchResults.withoutProject.map((thread, index) => {
                const itemIndex =
                  searchResults.withProject.length + index
                return (
                  <button
                    type="button"
                    key={thread.id}
                    data-index={itemIndex}
                    data-selected={selectedIndex === itemIndex}
                    onClick={() => handleSelectThread(thread.id)}
                    className={itemClass(selectedIndex === itemIndex)}
                  >
                    <Icon name="comment" size={16} />
                    <span className="truncate">{thread.title}</span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Rooms and Cowork sessions, by title */}
          {searchQuery && workHits.length > 0 && (
            <div data-testid="search-work-hits">
              <div className="px-2.5 pt-2 pb-1">
                <GroupLabel>{t('common:searchGroup.work')}</GroupLabel>
              </div>
              {workHits.map((work, index) => {
                const itemIndex =
                  searchResults.withProject.length +
                  searchResults.withoutProject.length +
                  index
                const Glyph = work.kind === 'room' ? Users : MessagesSquare
                return (
                  <button
                    type="button"
                    key={`${work.kind}-${work.id}`}
                    data-index={itemIndex}
                    data-selected={selectedIndex === itemIndex}
                    onClick={() => openWork(work)}
                    className={itemClass(selectedIndex === itemIndex)}
                  >
                    <Glyph className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{work.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {work.kind === 'room'
                        ? t('common:searchGroup.room')
                        : t('common:searchGroup.session')}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Pages, including those hidden from the sidebar */}
          {searchQuery && pageHits.length > 0 && (
            <div data-testid="search-page-hits">
              <div className="px-2.5 pt-2 pb-1">
                <GroupLabel>{t('common:searchGroup.pages')}</GroupLabel>
              </div>
              {pageHits.map((page, index) => {
                const itemIndex =
                  searchResults.withProject.length +
                  searchResults.withoutProject.length +
                  workHits.length +
                  index
                return (
                  <button
                    type="button"
                    key={page.id}
                    data-index={itemIndex}
                    data-selected={selectedIndex === itemIndex}
                    onClick={() => openPage(page)}
                    className={itemClass(selectedIndex === itemIndex)}
                  >
                    <Icon name="command" size={16} />
                    <span className="truncate">{page.title}</span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Settings pages and single controls */}
          {searchQuery && settingHits.length > 0 && (
            <div data-testid="search-setting-hits">
              <div className="px-2.5 pt-2 pb-1">
                <GroupLabel>{t('common:searchGroup.settings')}</GroupLabel>
              </div>
              {settingHits.map((entry, index) => {
                const itemIndex =
                  searchResults.withProject.length +
                  searchResults.withoutProject.length +
                  workHits.length +
                  pageHits.length +
                  index
                return (
                  <button
                    type="button"
                    key={entry.id}
                    data-index={itemIndex}
                    data-selected={selectedIndex === itemIndex}
                    onClick={() => openSetting(entry)}
                    className={itemClass(selectedIndex === itemIndex)}
                  >
                    <Icon name="sb-settings" size={16} />
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{entry.title}</span>
                      {entry.section !== entry.title && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {entry.section}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Matches inside the messages of other chats */}
          {searchQuery && messageHits.length > 0 && (
            <div data-testid="search-message-hits">
              <div className="px-2.5 pt-2 pb-1">
                <GroupLabel>{t('common:searchGroup.messages')}</GroupLabel>
              </div>
              {messageHits.map((hit, index) => {
                const itemIndex =
                  searchResults.withProject.length +
                  searchResults.withoutProject.length +
                  workHits.length +
                  pageHits.length +
                  settingHits.length +
                  index
                return (
                  <button
                    type="button"
                    key={`${hit.threadId}-${hit.messageId}`}
                    data-index={itemIndex}
                    data-selected={selectedIndex === itemIndex}
                    onClick={() => handleSelectThread(hit.threadId, hit)}
                    className={cn(
                      itemClass(selectedIndex === itemIndex),
                      'h-auto min-h-[34px] flex-col items-start gap-0 py-1.5'
                    )}
                  >
                    <span className="w-full truncate text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
                      {hit.threadTitle}
                    </span>
                    <RichSnippet
                      text={hit.snippet}
                      query={searchQuery}
                      className="w-full text-start"
                    />
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer with keyboard hints; phones have no arrow keys to hint at. */}
        <div className="hidden shrink-0 items-center gap-4 border-t border-dashed border-border px-4 py-2.5 text-[length:calc(var(--ui-font-base)*0.71875)] text-subtle-foreground sm:flex">
          <span>↑↓ {t('common:toNavigate')}</span>
          <span>↵ {t('common:toSelect')}</span>
          <span>esc {t('common:toClose')}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
