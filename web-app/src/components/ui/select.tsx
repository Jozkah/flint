import * as React from 'react'
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type SelectOption = {
  value: string
  label: React.ReactNode
  text: string
  disabled?: boolean
}

/** More options than this and the list gets a filter box. */
const SEARCH_THRESHOLD = 10

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (React.isValidElement<{ children?: React.ReactNode }>(node))
    return textOf(node.props.children)
  return ''
}

function collect(children: React.ReactNode, out: SelectOption[]) {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<Record<string, unknown>>(child)) return
    const props = child.props as {
      value?: string | number
      disabled?: boolean
      children?: React.ReactNode
    }
    if (child.type === 'option') {
      out.push({
        value: String(props.value ?? textOf(props.children)),
        label: props.children,
        text: textOf(props.children),
        disabled: props.disabled,
      })
    } else if (child.type === React.Fragment || child.type === 'optgroup') {
      collect(props.children, out)
    }
  })
}

export interface SelectProps {
  value: string | number
  /** Called with the picked value, shaped like a native change event. */
  onChange?: (event: { target: { value: string } }) => void
  /** `<option>` children, exactly as the native element took them. */
  children?: React.ReactNode
  className?: string
  disabled?: boolean
  id?: string
  placeholder?: string
  'aria-label'?: string
  'data-testid'?: string
}

/**
 * Drop-in for the native `<select>`: the closed state looks like the app's
 * other fields, and the open list is the app's own menu instead of the
 * operating system's, with a check on the current choice and a filter box
 * once the list is long.
 */
export function Select({
  value,
  onChange,
  children,
  className,
  disabled,
  id,
  placeholder,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: SelectProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const options: SelectOption[] = []
  collect(children, options)

  const current = String(value)
  const selected = options.find((o) => o.value === current)
  const searchable = options.length > SEARCH_THRESHOLD
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? options.filter((o) => o.text.toLowerCase().includes(needle))
    : options

  const pick = (next: string) => {
    setOpen(false)
    if (next !== current) onChange?.({ target: { value: next } })
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <DropdownMenuTrigger
        id={id}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        data-value={current}
        className={cn(
          'group inline-flex h-8 min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border-[0.8px] border-input bg-card px-2.5 text-xs text-foreground transition-[border-color,box-shadow] duration-150 outline-none hover:border-border-strong focus-visible:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/25 data-[state=open]:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11',
          className
        )}
      >
        <span
          className={cn(
            'min-w-0 truncate',
            !selected && 'text-muted-foreground'
          )}
        >
          {selected ? selected.label : (placeholder ?? '')}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-[max(8rem,var(--radix-dropdown-menu-trigger-width))] max-w-[min(24rem,90vw)] p-1"
      >
        {searchable && (
          <div className="sticky top-0 z-10 -mx-1 -mt-1 mb-1 flex items-center gap-2 border-b border-border bg-popover px-3 py-2">
            <SearchIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Keep typing from triggering the menu's type-ahead.
                if (e.key !== 'Escape' && e.key !== 'ArrowDown')
                  e.stopPropagation()
              }}
              placeholder="Filter…"
              aria-label="Filter options"
              className="w-full min-w-0 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        )}
        {shown.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            No matches
          </div>
        ) : (
          shown.map((o) => {
            const isSelected = o.value === current
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                data-value={o.value}
                disabled={o.disabled}
                onClick={() => pick(o.value)}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-[0.8125em] text-secondary-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11',
                  isSelected && 'bg-accent/60 text-foreground'
                )}
              >
                <span className="min-w-0 truncate">{o.label}</span>
                {isSelected && (
                  <CheckIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-acc-text"
                  />
                )}
              </button>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
