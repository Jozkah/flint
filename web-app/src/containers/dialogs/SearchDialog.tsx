import { useEffect, useState, useMemo, useRef, type ReactNode } from 'react'
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
  Search,
} from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { useThreads } from '@/hooks/useThreads'
import { localStorageKey } from '@/constants/localStorage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'

const MAX_RECENT_SEARCHES = 5

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
    'relative flex h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-secondary-foreground transition-[background-color,color,transform] duration-150 ease-expo hover:bg-accent hover:text-foreground active:scale-[.965] pointer-coarse:h-11',
    selected && 'bg-accent text-foreground'
  )

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium text-subtle-foreground uppercase">
      {children}
    </span>
  )
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [recentVersion, setRecentVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  const threads = useThreads((state) => state.threads)
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setSelectedIndex(0)
      setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
    }
  }, [open])

  // Load recent searches from localStorage
  const recentSearches = useMemo(() => {
    if (!open) return []

    const stored = localStorage.getItem(localStorageKey.recentSearches)
    if (!stored) return []

    try {
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
    localStorage.removeItem(localStorageKey.recentSearches)
    setRecentVersion((v) => v + 1)
  }

  const handleClose = () => {
    setSearchQuery('')
    onOpenChange(false)
  }

  const handleSelectThread = (threadId: string) => {
    // Save to recent searches
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

    handleClose()
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

  // Calculate all selectable items for keyboard navigation
  const allItems = useMemo(() => {
    const items: Array<{ type: 'new' | 'recent' | 'result'; id: string }> = []

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
    }

    return items
  }, [searchQuery, recentSearches, searchResults])

  // Reset selected index when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [allItems.length])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.querySelector(
        `[data-index="${selectedIndex}"]`
      )
      selectedElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, allItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selectedItem = allItems[selectedIndex]
      if (selectedItem) {
        if (selectedItem.type === 'new') {
          handleStartNewChat()
        } else {
          handleSelectThread(selectedItem.id)
        }
      }
    }
  }

  const handleStartNewChat = () => {
    handleClose()
    navigate({ to: '/' })
  }

  const showStartNewChat = !searchQuery
  const hasResults =
    searchResults.withProject.length > 0 ||
    searchResults.withoutProject.length > 0

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
            placeholder={t('common:searchThreads')}
            aria-label={t('common:searchThreads')}
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
              <h3 className="mb-1 text-[13px] font-semibold text-foreground">
                {t('common:noResultsFound')}
              </h3>
              <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                {t('common:noResultsFoundDesc')}
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
        </div>

        {/* Footer with keyboard hints; phones have no arrow keys to hint at. */}
        <div className="hidden shrink-0 items-center gap-4 border-t border-dashed border-border px-4 py-2.5 text-[11.5px] text-subtle-foreground sm:flex">
          <span>↑↓ {t('common:toNavigate')}</span>
          <span>↵ {t('common:toSelect')}</span>
          <span>esc {t('common:toClose')}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
