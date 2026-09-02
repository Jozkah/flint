import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconSearch, IconX } from '@tabler/icons-react'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import {
  buildSettingsIndex,
  searchSettings,
  type SettingsIndexEntry,
} from '@/lib/settingsSearch'

/**
 * Global settings search.
 *
 * The index is built from the typed registry plus the live provider list —
 * never by scraping the rendered page — so results exist for settings whose
 * page is not mounted, and providers added or removed at runtime appear and
 * disappear with the rebuild. It carries labels and keywords only: no current
 * values, so no API key or path can surface here.
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
  const inputRef = useRef<HTMLInputElement>(null)

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

  // A new query restarts the selection at the top; `setQuery` re-opens the
  // panel by clearing the dismissal in the same update.
  useEffect(() => {
    setActive(0)
  }, [query])

  const open = !dismissed && query.trim().length > 0

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
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = results[active]
      if (entry) select(entry)
    }
  }

  return (
    <div className="relative px-1.5 pb-2">
      <div className="relative">
        <IconSearch
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
          onFocus={() => setDismissed(false)}
          placeholder={t('common:settingsSearch.placeholder')}
          aria-label={t('common:settingsSearch.label')}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="settings-search-results"
          aria-activedescendant={
            open && results[active]
              ? `settings-search-${results[active].id}`
              : undefined
          }
          autoComplete="off"
          className="h-8 pl-7 pr-7 text-sm"
        />
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
            <IconX size={14} />
          </button>
        )}
      </div>

      {open && (
        <div
          id="settings-search-results"
          role="listbox"
          aria-label={t('common:settingsSearch.results')}
          className="absolute left-1.5 right-1.5 top-full z-50 max-h-96 overflow-y-auto rounded-md border bg-main-view shadow-md"
        >
          <p
            className="px-2 py-1 text-[11px] text-muted-foreground"
            aria-live="polite"
          >
            {t('common:settingsSearch.count', { count: results.length })}
          </p>
          {results.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-muted-foreground">
              {t('common:settingsSearch.empty')}
            </p>
          ) : (
            results.map((entry, i) => (
              <div
                key={entry.id}
                id={`settings-search-${entry.id}`}
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => select(entry)}
                className={cn(
                  'cursor-pointer px-2 py-1.5',
                  i === active && 'bg-secondary'
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {entry.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {entry.section}
                  </span>
                </div>
                {entry.description && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {entry.description}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
