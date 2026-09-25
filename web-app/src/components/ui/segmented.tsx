import * as React from 'react'

import { cn } from '@/lib/utils'

export type SegmentedOption<T extends string> = {
  value: T
  label: React.ReactNode
  icon?: React.ReactNode
  disabled?: boolean
}

/**
 * A row of equal buttons with a gradient pill that glides to the selected
 * one. Arrow keys move the selection (radiogroup semantics).
 */
function Segmented<T extends string>({
  options,
  value,
  onValueChange,
  className,
  size = 'default',
  'aria-label': ariaLabel,
}: {
  options: SegmentedOption<T>[]
  value: T
  onValueChange: (value: T) => void
  className?: string
  size?: 'default' | 'sm'
  'aria-label'?: string
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )
  const count = options.length
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  const move = (from: number, step: number) => {
    for (let i = 1; i <= count; i++) {
      const next = (from + step * i + count * i) % count
      if (!options[next].disabled) {
        onValueChange(options[next].value)
        refs.current[next]?.focus()
        return
      }
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-slot="segmented"
      className={cn('relative flex w-full items-start gap-2', className)}
    >
      <span
        aria-hidden
        style={{
          // Equal cells separated by the 0.5rem gap.
          width: `calc((100% - ${count - 1} * 0.5rem) / ${count})`,
          left: `calc((100% - ${count - 1} * 0.5rem) / ${count} * ${index} + ${index} * 0.5rem)`,
        }}
        className={cn(
          'pointer-events-none absolute top-0 rounded-lg border border-primary bg-grad transition-[left] duration-300 ease-expo',
          size === 'sm' ? 'h-6' : 'h-7'
        )}
      />
      {options.map((o, i) => {
        const on = i === index
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            data-state={on ? 'on' : 'off'}
            disabled={o.disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => onValueChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(i, 1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(i, -1)
              }
            }}
            className={cn(
              'relative z-10 flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-[0.8px] px-2 text-xs leading-none font-medium transition-[color,background-color,border-color,transform] duration-200 ease-expo outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.97] disabled:pointer-events-none disabled:opacity-45 [&_svg:not([class*="size-"])]:size-3.5',
              size === 'sm' ? 'h-6' : 'h-7',
              on
                ? 'border-transparent bg-transparent text-on-grad'
                : 'border-border bg-card text-secondary-foreground hover:bg-hover-row'
            )}
          >
            {o.icon}
            <span className="truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
