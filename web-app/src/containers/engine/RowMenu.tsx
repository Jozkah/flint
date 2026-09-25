import type { ReactNode } from 'react'
import { MoreVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type RowMenuItem =
  | {
      label: ReactNode
      icon?: ReactNode
      onSelect: () => void
      destructive?: boolean
      disabled?: boolean
    }
  | 'separator'

/** The "more" (three dots) button at the end of a row, opening a real menu. */
export function RowMenu({
  label,
  items,
  className,
}: {
  /** Accessible name of the trigger, e.g. "Model actions". */
  label: string
  items: RowMenuItem[]
  className?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          className={cn('text-muted-foreground pointer-coarse:size-11', className)}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {items.map((item, i) =>
          item === 'separator' ? (
            <DropdownMenuSeparator key={`sep-${i}`} />
          ) : (
            <DropdownMenuItem
              key={i}
              disabled={item.disabled}
              variant={item.destructive ? 'destructive' : undefined}
              onSelect={item.onSelect}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
