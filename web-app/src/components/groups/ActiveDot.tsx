import { cn } from '@/lib/utils'

/**
 * The shared "running" marker for chats, Cowork sessions, Rooms and groups.
 * Colour is never the only signal: it carries an accessible label and tooltip.
 */
export function ActiveDot({ label, className }: { label: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="active-dot"
      className={cn('inline-block size-2 shrink-0 rounded-full bg-success motion-safe:animate-pulse', className)}
    />
  )
}
