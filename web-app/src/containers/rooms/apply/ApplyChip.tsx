import { cn } from '@/lib/utils'

/** A small bordered label on a file row or in the header. */
export function ApplyChip({ className, children, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border-[0.8px] border-border px-1.5 text-xs text-muted-foreground',
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}
