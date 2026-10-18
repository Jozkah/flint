import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * One section of a details surface (the chat's Details column, the Cowork
 * output panel, the session details dialog): a quiet card with a 13px title
 * row, optional actions on the right, and the content under it. Every
 * reference-material section uses it, so the three surfaces share one edge,
 * one title size and one rhythm.
 */
export function DetailsCard({
  title,
  description,
  actions,
  children,
  className,
  headingLevel = 'h3',
  ...rest
}: Omit<React.ComponentProps<'section'>, 'title'> & {
  title?: ReactNode
  /** One short line under the title. Longer rationale goes in a `HelpTip`. */
  description?: ReactNode
  actions?: ReactNode
  headingLevel?: 'h2' | 'h3'
}) {
  const Heading = headingLevel
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-[10px] border-[0.8px] border-border bg-card p-3 text-xs',
        className
      )}
      {...rest}
    >
      {(title || actions) && (
        <header className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <Heading className="text-[length:calc(var(--ui-font-base)*0.8125)] leading-5 font-medium text-foreground">
                {title}
              </Heading>
            )}
            {description && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {actions}
            </div>
          )}
        </header>
      )}
      {children}
    </section>
  )
}

/**
 * Rationale that used to sit under a control as a paragraph: now behind a
 * small (i) that shows it on hover and focus. The text stays in the DOM,
 * visually hidden, so `aria-describedby` and tests still find it.
 */
export function HelpTip({
  id,
  label,
  children,
  className,
}: {
  /** The id a control's `aria-describedby` points at. */
  id?: string
  /** The accessible name of the (i) button. */
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover-btn hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring pointer-coarse:size-8',
              className
            )}
            onClick={(event) => {
              // Inside a <summary> the click must not toggle the disclosure.
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <Info className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 leading-snug text-pretty">
          {children}
        </TooltipContent>
      </Tooltip>
      <span id={id} className="sr-only">
        {children}
      </span>
    </>
  )
}
