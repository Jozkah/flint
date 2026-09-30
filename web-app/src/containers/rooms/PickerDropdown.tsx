import { Check, ChevronDown, Search } from 'lucide-react'
import { useState, type ReactNode } from 'react'
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

export type PickerItem = {
  value: string
  label: string
  /** A quiet second line: what the choice does, or who serves it. */
  hint?: string
  /** The mark shown before the label, in the menu and on the button. */
  icon?: ReactNode
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
  footer,
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
  /** Extra actions under the list, each closing the menu when chosen. */
  footer?: { label: string; icon?: ReactNode; onSelect: () => void }[]
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
}) {
  const [query, setQuery] = useState('')
  const current = groups.flatMap((g) => g.items).find((i) => i.value === value)
  const label = shownLabel ?? current?.label
  const q = query.trim().toLowerCase()
  const shown = q
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q)),
        }))
        .filter((g) => g.items.length > 0)
    : groups

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery('')}>
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
            <span className="min-w-0 truncate">{label ?? placeholder}</span>
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={12}
        className="max-h-[min(32rem,70vh)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-1.5"
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
                if (e.key !== 'Escape' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
                  e.stopPropagation()
                }
              }}
            />
          </div>
        )}
        {menuLabel && !searchPlaceholder && <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>}
        {shown.length === 0 && (
          <div className="px-2.5 py-3 text-xs text-muted-foreground">—</div>
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
                  onSelect={() => onChange(item.value)}
                  className={cn('items-start gap-2.5 px-2.5 py-2', selected && 'bg-accent')}
                >
                  {item.icon && <span className="mt-px shrink-0">{item.icon}</span>}
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="truncate text-[13px] font-medium">{item.label}</span>
                    {item.hint && (
                      <span className="text-xs leading-[1.4] text-muted-foreground">{item.hint}</span>
                    )}
                  </span>
                  {selected ? (
                    <Check aria-hidden className="size-4 shrink-0 text-foreground" />
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </div>
        ))}
        {footer && footer.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {footer.map((f) => (
              <DropdownMenuItem key={f.label} onSelect={f.onSelect} className="gap-2.5 px-2.5 py-2">
                {f.icon}
                <span className="text-[13px] font-medium">{f.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
