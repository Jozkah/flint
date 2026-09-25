/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * Small status label: 22px, card-coloured, with an optional status dot. The
 * `live` flag adds a ping ring to the dot for things happening right now.
 */
const chipVariants = cva(
  'inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 text-xs leading-none font-medium whitespace-nowrap text-secondary-foreground [&_svg:not([class*="size-"])]:size-3',
  {
    variants: {
      tone: {
        neutral: '[--chip-dot:var(--subtle-foreground)]',
        ok: '[--chip-dot:var(--success)]',
        warn: 'text-warning [--chip-dot:var(--warning)]',
        err: '[--chip-dot:var(--destructive)]',
        info: '[--chip-dot:var(--info)]',
        merged: '[--chip-dot:var(--merged)]',
      },
      mono: { true: 'font-mono font-normal', false: '' },
    },
    defaultVariants: { tone: 'neutral', mono: false },
  }
)

function Chip({
  className,
  tone,
  mono,
  dot = false,
  live = false,
  children,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof chipVariants> & { dot?: boolean; live?: boolean }) {
  return (
    <span
      data-slot="chip"
      data-tone={tone ?? 'neutral'}
      className={cn(chipVariants({ tone, mono }), className)}
      {...props}
    >
      {(dot || live) && (
        <span
          aria-hidden
          className="relative size-1.5 shrink-0 rounded-full bg-[var(--chip-dot)]"
        >
          {live && (
            <span className="absolute inset-0 rounded-full bg-[var(--chip-dot)] motion-safe:animate-ping" />
          )}
        </span>
      )}
      {children}
    </span>
  )
}

export { Chip, chipVariants }
