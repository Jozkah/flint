import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, CornerDownLeft, Search, SearchX, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import {
  buildSettingsIndex,
  searchSettings,
  type SettingsIndexEntry,
} from '@/lib/settingsSearch'

/** The results panel: at least as wide as the field, up to this. */
/** Breathing room between the panel and the window edge. */
const EDGE = 8

/**
 * Mark every case-insensitive occurrence of the query's words in `text`.
 * Fuse's fuzzy matching may rank a row the literal query never appears in;
 * such a row simply shows unmarked.
 */
export function highlightMatches(
  text: string,
  query: string
): React.ReactNode {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (words.length === 0) return text
  const re = new RegExp(`(${words.join('|')})`, 'gi')
  const parts = text.split(re)
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        className="rounded-[2px] bg-primary/15 px-px text-foreground [text-decoration:none]"
      >
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

/**
 * Global settings search.
 *
 * The index is built from the typed registry plus the live provider list —
 * never by scraping the rendered page — so results exist for settings whose
 * page is not mounted, and providers added or removed at runtime appear and
 * disappear with the rebuild. It carries labels and keywords only: no current
 * values, so no API key or path can surface here.
 *
 * The results render through a portal, anchored to the field: the sidebar is
 * narrow and clips its children, and a list confined to it cut every title
 * and description short.
 */
export function SettingsSearch() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { providers } = useModelProvider()
  const query = useSettingsSearch((s) => s.query)
  const setQuery = useSettingsSearch((s) => s.setQuery)
  const clear = useSettingsSearch((s) => s.clear)
  // Dismissal lives in the store, not here: selecting a result navigates, and
  // the navigation remounts this component. Local state came back false with
  // the query still set, so the panel reopened over the page just opened.
  const dismissed = useSettingsSearch((s) => s.dismissed)
  const setDismissed = useSettingsSearch((s) => s.setDismissed)
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Rebuilt when the provider list or the language changes; the local index is
  // small enough that searching on every keystroke needs no debounce.
  // `i18n` is optional-chained: the translation hook is widely mocked, and a
  // missing instance must degrade to "language never changes", not crash the
  // whole settings sidebar.
  const language = i18n?.language
  const index = useMemo(
    () => buildSettingsIndex(t, providers ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, providers, language]
  )
  const results = useMemo(() => searchSettings(index, query), [index, query])

  // Group the ranked results under their Settings section, preserving relevance
  // order: sections appear in the order their first (best-ranked) result did,
  // and results keep their rank within a section. `flat` is the same list in
  // that grouped visual order, so keyboard navigation (which indexes into it)
  // and the rendered order can never disagree across group boundaries.
  const grouped = useMemo(() => {
    const order: string[] = []
    const bySection = new Map<string, SettingsIndexEntry[]>()
    for (const entry of results) {
      const list = bySection.get(entry.section)
      if (list) list.push(entry)
      else {
        bySection.set(entry.section, [entry])
        order.push(entry.section)
      }
    }
    const flat: SettingsIndexEntry[] = []
    const sections = order.map((section) => {
      const items = bySection.get(section) ?? []
      const start = flat.length
      flat.push(...items)
      return { section, start, items }
    })
    return { flat, sections }
  }, [results])
  const flatResults = grouped.flat

  // A new query restarts the selection at the top; `setQuery` re-opens the
  // panel by clearing the dismissal in the same update.
  useEffect(() => {
    setActive(0)
  }, [query])

  const open = !dismissed && query.trim().length > 0

  // Where the panel goes: under the field, as wide as the field or wider,
  // never past the window's edge, and tall enough to scroll inside itself.
  const [place, setPlace] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
  } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const width = Math.min(r.width, vw - EDGE * 2)
      const left = Math.max(EDGE, Math.min(r.left, vw - width - EDGE))
      const top = r.bottom + 4
      const maxHeight = Math.max(160, Math.min(384, vh - top - EDGE))
      setPlace({ top, left, width, maxHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open])

  // The highlighted row follows the arrow keys into view.
  useEffect(() => {
    if (!open) return
    const entry = flatResults[active]
    if (!entry) return
    const el = document.getElementById(`settings-search-${entry.id}`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open, flatResults])

  // A click anywhere else closes the panel; the field keeps its query.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (anchorRef.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      setDismissed(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, setDismissed])

  // `/` anywhere in Settings jumps to the field, the way it does on most
  // documentation sites; typing in another field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const select = useCallback(
    (entry: SettingsIndexEntry) => {
      // Parked before navigating: the page's SettingTarget claims it on mount.
      if (entry.anchor) useSettingsSearch.getState().requestTarget(entry.anchor)
      setDismissed(true)
      navigate(
        entry.params
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ({ to: entry.route, params: entry.params } as any)
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ({ to: entry.route } as any)
      )
    },
    [navigate, setDismissed]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // First Escape closes the results, a second clears the query — closing
      // and wiping in one keystroke loses a query the user may still want.
      if (open) setDismissed(true)
      else clear()
      return
    }
    if (!open || flatResults.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % flatResults.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + flatResults.length) % flatResults.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = flatResults[active]
      if (entry) select(entry)
    }
  }

  /**
   * The trail above a row: where in Settings it lives. The group header
   * already names the page, so a plain setting shows none; a provider's own
   * setting adds the page the provider is under, and a page result says it
   * opens a page.
   */
  const crumbs = (entry: SettingsIndexEntry): string[] => {
    if (entry.kind === 'provider-setting')
      return [t('common:modelProviders'), entry.section]
    if (entry.kind === 'provider') return [t('common:modelProviders')]
    if (entry.kind === 'page') return [t('common:settingsSearch.pageCrumb')]
    return []
  }

  const showSlashHint = !focused && query.length === 0

  const panel = open && (
    <div
      ref={listRef}
      id="settings-search-results"
      role="listbox"
      aria-label={t('common:settingsSearch.results')}
      data-testid="settings-search-results"
      style={
        place
          ? {
              position: 'fixed',
              top: place.top,
              left: place.left,
              width: place.width,
              maxHeight: place.maxHeight,
            }
          : undefined
      }
      className={cn(
        'z-50 flex origin-top flex-col overflow-hidden rounded-xl border-[0.8px] border-border bg-popover text-popover-foreground shadow-pop motion-safe:animate-[dd-in_.16s_var(--expo)_both]',
        // Before the first measurement (and in tests), sit under the field.
        !place && 'absolute left-1.5 right-1.5 top-full mt-1 max-h-96'
      )}
    >
      <p
        className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <span className="tabular-nums">
          {t('common:settingsSearch.count', { count: flatResults.length })}
        </span>
        {flatResults.length > 0 && (
          <span
            className="hidden items-center gap-1 sm:inline-flex"
            aria-hidden
          >
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <Kbd>
              <CornerDownLeft />
            </Kbd>
          </span>
        )}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]">
        {flatResults.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
            <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
              <SearchX size={16} aria-hidden />
            </span>
            <p className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
              {t('common:settingsSearch.empty')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('common:settingsSearch.emptyHint')}
            </p>
          </div>
        ) : (
          grouped.sections.map(({ section, start, items }) => (
            <div
              key={section}
              role="group"
              aria-label={section}
              className="border-t border-border/70 pt-1 first:border-t-0 first:pt-0"
            >
              <p className="sticky top-0 z-10 bg-popover px-2.5 pt-1.5 pb-1 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[.02em] text-subtle-foreground uppercase">
                {section}
              </p>
              {items.map((entry, j) => {
                const i = start + j
                const trail = crumbs(entry)
                const selected = i === active
                return (
                  <div
                    key={entry.id}
                    id={`settings-search-${entry.id}`}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => select(entry)}
                    className={cn(
                      'group/row relative flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 pointer-coarse:py-2.5',
                      selected &&
                        'bg-accent before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      {trail.length > 0 && (
                        <p className="mb-0.5 flex items-center gap-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground">
                          {trail.map((crumb, k) => (
                            <Fragment key={k}>
                              {k > 0 && (
                                <ChevronRight
                                  size={10}
                                  className="shrink-0"
                                  aria-hidden
                                />
                              )}
                              <span className="truncate">{crumb}</span>
                            </Fragment>
                          ))}
                        </p>
                      )}
                      <span className="block text-[length:calc(var(--ui-font-base)*0.8125)] leading-snug font-medium text-foreground">
                        {highlightMatches(entry.title, query)}
                      </span>
                      {entry.description && (
                        <p
                          className="mt-0.5 line-clamp-2 text-xs leading-[1.4] text-muted-foreground"
                          title={entry.description}
                        >
                          {highlightMatches(entry.description, query)}
                        </p>
                      )}
                    </div>
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity',
                        selected && 'opacity-100'
                      )}
                      aria-hidden
                    >
                      <CornerDownLeft size={13} />
                    </span>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )

  return (
    <div className="relative px-1.5 pb-2">
      <div ref={anchorRef} className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true)
            setDismissed(false)
          }}
          onBlur={() => setFocused(false)}
          placeholder={t('common:settingsSearch.placeholder')}
          aria-label={t('common:settingsSearch.label')}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="settings-search-results"
          aria-activedescendant={
            open && flatResults[active]
              ? `settings-search-${flatResults[active].id}`
              : undefined
          }
          autoComplete="off"
          className="h-9 pl-7 pr-7 text-base pointer-coarse:h-11 md:text-sm"
        />
        {showSlashHint && (
          <Kbd
            className="absolute right-2 top-1/2 -translate-y-1/2 pointer-coarse:hidden"
            aria-hidden
          >
            /
          </Kbd>
        )}
        {query.length > 0 && (
          <button
            type="button"
            aria-label={t('common:settingsSearch.clear')}
            onClick={() => {
              clear()
              inputRef.current?.focus()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X size={14} aria-hidden />
          </button>
        )}
        {/* Not yet measured: render in place so the field still owns it. */}
        {panel && !place && panel}
      </div>
      {panel && place && createPortal(panel, document.body)}
    </div>
  )
}
