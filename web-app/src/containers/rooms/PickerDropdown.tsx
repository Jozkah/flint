import { Check, ChevronDown, Search } from 'lucide-react'
import { disambiguateModels, middleTruncate } from '@/lib/modelDisplayName'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  EMPTY_PICKER_FILTERS,
  applyPickerFilters,
  hasFacets,
  isFiltered,
  pickerFacets,
  type PickerFilterState,
  type PickerMeta,
} from '@/lib/pickerFilters'
import { PickerFilterButton, PickerFilterPanel } from './PickerFilterPanel'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type PickerItem = PickerMeta & {
  value: string
  label: string
  /** A quiet second line: what the choice does, or who serves it. */
  hint?: string
  /** Another quiet line beneath: where it is served, its size, a variant. */
  secondary?: ReactNode
  /** The mark shown before the label, in the menu and on the button. */
  icon?: ReactNode
  /** Choosing it leaves the menu open, for a row that opens a field beneath it. */
  keepOpen?: boolean
}

export type PickerGroup = { label?: string; items: PickerItem[] }

/**
 * A picker in the look of the composer's own menus (the work-profile and
 * assistant menus, the model list): a button with the choice and its mark, and
 * a menu whose rows carry a mark, a name, a quiet line beneath, and a check on
 * the current one. It can search, as the model list does.
 */
export function PickerDropdown({
  id,
  value,
  groups,
  placeholder,
  menuLabel,
  shownLabel,
  searchPlaceholder,
  onChange,
  inlineInput,
  footer,
  searchAction,
  emptyLabel,
  disabled,
  invalid,
  describedBy,
}: {
  id?: string
  value: string | null
  groups: PickerGroup[]
  placeholder: string
  /** The small heading at the top of the menu. */
  menuLabel?: string
  /** Overrides the label of the current choice, for a value not in the list. */
  shownLabel?: string
  /** When set, the menu opens with a search box in it. */
  searchPlaceholder?: string
  onChange: (value: string) => void
  /**
   * A text field shown inside the menu, under the row with value `forValue`
   * while that row is the current choice (the "Other" row's own input).
   */
  inlineInput?: {
    forValue: string
    value: string
    placeholder: string
    onChange: (text: string) => void
  }
  /** Extra actions under the list, each closing the menu when chosen. */
  footer?: { label: string; icon?: ReactNode; onSelect: () => void }[]
  /** A control beside the search box, such as a filter button. */
  searchAction?: ReactNode
  /** Shown in place of the list when there is nothing to pick (or nothing matches). */
  emptyLabel?: string
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // What the filters say is kept for as long as this picker is on screen.
  const [filters, setFilters] = useState<PickerFilterState>(EMPTY_PICKER_FILTERS)
  const [panelOpen, setPanelOpen] = useState(false)
  const current = groups.flatMap((g) => g.items).find((i) => i.value === value)
  const label = shownLabel ?? current?.label
  // Rows that read alike (two quants of one model) carry what tells them apart.
  const disambiguation = useMemo(() => {
    const items = groups.flatMap((g) => g.items)
    // Only rows that still read alike once cut to the width the list shows;
    // names that differ in full need no chip. `value` is an encoded key
    // (JSON for the model pickers), never a file name, so it is not read.
    const shown = new Map<string, number>()
    for (const i of items) {
      const cut = middleTruncate(i.label, 38)
      shown.set(cut, (shown.get(cut) ?? 0) + 1)
    }
    return disambiguateModels(
      items
        .filter((i) => (shown.get(middleTruncate(i.label, 38)) ?? 0) > 1)
        .map((i) => ({ key: i.value, name: i.label }))
    )
  }, [groups])
  const q = query.trim().toLowerCase()
  const facets = useMemo(() => pickerFacets(groups), [groups])
  const canFilter = Boolean(searchPlaceholder) && hasFacets(facets)
  const filtered = canFilter ? applyPickerFilters(groups, filters) : groups
  const shown = q
    ? filtered
        .map((g) => ({
          ...g,
          items: g.items.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q)),
        }))
        .filter((g) => g.items.length > 0)
    : filtered
  const filtersOn = canFilter && isFiltered(filters)
  const filterNames = [
    filters.source !== 'all' && t(`common:picker.source${filters.source === 'local' ? 'Local' : 'Cloud'}`),
    ...filters.capabilities.map((c) => t(`common:picker.cap.${c}`)),
    filters.loadedOnly && t('common:picker.loadedNow'),
  ].filter(Boolean)

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setQuery('')
          setPanelOpen(false)
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          title={label}
          className={cn(
            'h-8 w-full min-w-0 justify-between gap-1.5 px-2.5 text-xs font-medium pointer-coarse:h-11',
            invalid && 'border-destructive',
            label ? 'text-secondary-foreground' : 'text-muted-foreground'
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {current?.icon}
            <span className="min-w-0 truncate">
              {label ? middleTruncate(label, 34) : placeholder}
            </span>
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        // Esc folds the filter panel away before it closes the menu.
        onEscapeKeyDown={(e) => {
          if (panelOpen) {
            e.preventDefault()
            setPanelOpen(false)
          }
        }}
        // Exactly the field's width and left edge, whatever the screen: on a phone
        // the field is the full row, so the menu is too. Never wider than the screen.
        className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-(--radix-dropdown-menu-trigger-width) min-w-(--radix-dropdown-menu-trigger-width) max-w-[min(var(--radix-dropdown-menu-trigger-width),calc(100vw-1.5rem))] overflow-y-auto rounded-lg p-1"
      >
        {searchPlaceholder && (
          <div className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-2 pt-1">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
              onChange={(e) => setQuery(e.target.value)}
              // Typing searches; it must not jump the menu to a row by its first letter.
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  // Down from the box goes into the list, to its first row.
                  e.preventDefault()
                  e.stopPropagation()
                  e.currentTarget
                    .closest('[data-slot="dropdown-menu-content"]')
                    ?.querySelector<HTMLElement>('[role="menuitemradio"]')
                    ?.focus()
                } else if (e.key !== 'Escape' && e.key !== 'ArrowUp') {
                  e.stopPropagation()
                }
              }}
            />
            {searchAction}
            {canFilter && (
              <PickerFilterButton
                state={filters}
                open={panelOpen}
                onToggle={() => setPanelOpen((o) => !o)}
              />
            )}
          </div>
        )}
        {canFilter && panelOpen && (
          // Tab and typing belong to the panel's own buttons, not to the menu's row jumps.
          <div
            onKeyDown={(e) => {
              if (e.key !== 'Escape') e.stopPropagation()
            }}
          >
            <PickerFilterPanel facets={facets} state={filters} onChange={setFilters} />
          </div>
        )}
        {menuLabel && !searchPlaceholder && <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>}
        {shown.length === 0 && (
          <div className="flex flex-col items-start gap-1 px-2.5 py-3 text-xs text-muted-foreground">
            {filtersOn || q ? (
              <span>
                {filterNames.length > 0
                  ? t('common:picker.noMatchFilters', { filters: filterNames.join(', ') })
                  : t('common:picker.noMatch')}
              </span>
            ) : (
              <span>{emptyLabel ?? '—'}</span>
            )}
            {filtersOn && !panelOpen && (
              <button
                type="button"
                onClick={() => setFilters(EMPTY_PICKER_FILTERS)}
                onKeyDown={(e) => e.stopPropagation()}
                className="cursor-pointer underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              >
                {t('common:picker.clearFilters')}
              </button>
            )}
          </div>
        )}
        {shown.map((group, gi) => (
          <div key={group.label ?? gi}>
            {gi > 0 && <DropdownMenuSeparator />}
            {group.label && <DropdownMenuLabel>{group.label}</DropdownMenuLabel>}
            {group.items.map((item) => {
              const selected = item.value === value
              return (
                <DropdownMenuItem
                  key={item.value}
                  role="menuitemradio"
                  aria-checked={selected}
                  onSelect={(e) => {
                    if (item.keepOpen) e.preventDefault()
                    onChange(item.value)
                  }}
                  className={cn('items-center gap-2.5 px-2.5 py-1.5', selected && 'bg-accent')}
                >
                  {item.icon && <span className="shrink-0">{item.icon}</span>}
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-medium"
                        title={item.label}
                      >
                        {middleTruncate(item.label, 38)}
                      </span>
                      {disambiguation.has(item.value) && (
                        <span
                          className="shrink-0 rounded bg-muted px-1 font-mono text-[length:calc(var(--ui-font-base)*0.65625)] text-muted-foreground"
                          title={item.label}
                          data-testid="picker-disambiguator"
                        >
                          {disambiguation.get(item.value)!.label}
                        </span>
                      )}
                    </span>
                    {item.hint && (
                      <span className="text-[length:calc(var(--ui-font-base)*0.6875)] leading-[1.35] text-muted-foreground">{item.hint}</span>
                    )}
                    {item.secondary && (
                      <span className="text-[length:calc(var(--ui-font-base)*0.6875)] leading-[1.35] text-muted-foreground">{item.secondary}</span>
                    )}
                  </span>
                  {selected ? (
                    <Check aria-hidden className="size-4 shrink-0 text-foreground" />
                  ) : null}
                </DropdownMenuItem>
              )
            })}
            {inlineInput &&
              group.items.some((i) => i.value === inlineInput.forValue) &&
              value === inlineInput.forValue && (
                <div className="px-2.5 pb-2 pt-1">
                  <input
                    autoFocus
                    value={inlineInput.value}
                    placeholder={inlineInput.placeholder}
                    aria-label={inlineInput.placeholder}
                    className="h-8 w-full rounded-lg border-[0.8px] border-border bg-card px-2 text-[length:calc(var(--ui-font-base)*0.8125)] text-foreground outline-hidden placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
                    onChange={(e) => inlineInput.onChange(e.target.value)}
                    // Typing is typing: no row-by-first-letter jumps, and Enter
                    // settles the menu instead of submitting the form behind it.
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') return
                      e.stopPropagation()
                      if (e.key === 'Enter') e.preventDefault()
                    }}
                  />
                </div>
              )}
          </div>
        ))}
        {footer && footer.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {footer.map((f) => (
              <DropdownMenuItem key={f.label} onSelect={f.onSelect} className="gap-2.5 px-2.5 py-1.5">
                {f.icon}
                <span className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium">{f.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
