import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The heading of a collapsible section in session details: the title, what
 * the section says at a glance, and a chevron, all one button. Closed, the
 * section is the design's quiet row; open, it shows everything it did before.
 *
 * Without `onToggle` it is the plain heading the section always had, so a
 * section rendered on its own (its tests, a settings page) is unchanged.
 */
export function CoworkCollapseHeader({
  title,
  extra,
  open,
  onToggle,
  className,
}: {
  title: ReactNode
  /** Beside the title, visible open or closed: a count, a state. */
  extra?: ReactNode
  open: boolean
  onToggle?: () => void
  className?: string
}) {
  const heading = (
    <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
  )
  if (!onToggle) {
    return (
      <>
        {heading}
        {extra}
      </>
    )
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11',
        className
      )}
    >
      {heading}
      {extra}
      <ChevronDown
        aria-hidden
        className={cn(
          'ml-auto size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-expo',
          open && 'rotate-180'
        )}
      />
    </button>
  )
}
