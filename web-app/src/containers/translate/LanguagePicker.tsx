import { useId, useMemo, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  AUTO_LANGUAGE,
  TRANSLATE_LANGUAGE_INFO,
  filterLanguages,
} from '@/lib/translatePrompt'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const RECENT_KEY = 'flint:translate-recent-languages'
const RECENT_MAX = 4

const readRecent = (): string[] => {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

const writeRecent = (name: string) => {
  try {
    const next = [name, ...readRecent().filter((n) => n !== name)].slice(
      0,
      RECENT_MAX
    )
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: recents just do not persist.
  }
}

type Props = {
  'value': string
  'onChange': (name: string) => void
  /** Offer "Detect language" first (source side). */
  'allowAuto'?: boolean
  'aria-label'?: string
  'data-testid'?: string
  'className'?: string
}

/**
 * Language picker with a type-ahead filter: the list is long, so typing
 * narrows it by English or native name; recently used languages lead.
 */
export function LanguagePicker({
  value,
  onChange,
  allowAuto,
  'aria-label': ariaLabel,
  'data-testid': testId,
  className,
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<string[]>(readRecent)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // Two pickers share a page, so the ids must be per instance.
  const uid = useId()
  const listId = `${uid}-list`
  const optionId = (i: number) => `${uid}-opt-${i}`

  const items = useMemo(() => {
    const langs = filterLanguages(query, recent).map((l) => ({
      value: l.name,
      label: l.name,
      native: l.native === l.name ? '' : l.native,
    }))
    const detect = t('common:translate.detect')
    const showAuto =
      allowAuto &&
      (!query.trim() ||
        detect.toLowerCase().includes(query.trim().toLowerCase()))
    return showAuto
      ? [{ value: AUTO_LANGUAGE, label: detect, native: '' }, ...langs]
      : langs
  }, [query, recent, allowAuto, t])

  const current =
    value === AUTO_LANGUAGE
      ? t('common:translate.detect')
      : (TRANSLATE_LANGUAGE_INFO.find((l) => l.name === value)?.name ?? value)

  const pick = (v: string) => {
    setOpen(false)
    setQuery('')
    if (v !== AUTO_LANGUAGE) {
      writeRecent(v)
      setRecent(readRecent())
    }
    if (v !== value) onChange(v)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
        setActive(0)
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        data-testid={testId}
        data-value={value}
        className={cn(
          'group inline-flex h-8 min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border-[0.8px] border-input bg-card px-2.5 text-xs text-foreground outline-none transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus-visible:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/25 data-[state=open]:border-border-strong pointer-coarse:h-11',
          className
        )}
      >
        <span className="min-w-0 truncate">{current}</span>
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(18rem,calc(100vw-2rem))] p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <SearchIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              items[active] ? optionId(active) : undefined
            }
            aria-label={t('common:translate.searchLanguages')}
            placeholder={t('common:translate.searchLanguages')}
            value={query}
            data-testid="translate-language-search"
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, items.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                const item = items[active]
                if (item) pick(item.value)
              } else if (e.key !== 'Escape') {
                e.stopPropagation()
              }
            }}
            className="w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="max-h-64 overflow-y-auto p-1"
        >
          {items.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {t('common:translate.noLanguages')}
            </div>
          ) : (
            items.map((item, i) => (
              <button
                key={item.value}
                type="button"
                id={optionId(i)}
                role="option"
                tabIndex={-1}
                aria-selected={item.value === value}
                data-value={item.value}
                ref={(el) => {
                  if (el && i === active)
                    el.scrollIntoView?.({ block: 'nearest' })
                }}
                onClick={() => pick(item.value)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-xs text-secondary-foreground outline-none transition-colors pointer-coarse:min-h-11',
                  i === active && 'bg-accent text-foreground',
                  item.value === value && 'font-medium text-foreground'
                )}
              >
                <span className="min-w-0 truncate">
                  {item.label}
                  {item.native && (
                    <span className="ml-2 text-muted-foreground">
                      {item.native}
                    </span>
                  )}
                </span>
                {item.value === value && (
                  <CheckIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-acc-text"
                  />
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
