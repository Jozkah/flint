import { SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** The composer's less-used controls behind one compact icon button. */
export function ComposerOptionsMenu({
  label,
  children,
}: {
  label: string
  /** Kept at call sites for compatibility; active state is visible in the panel. */
  active: readonly string[]
  children: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          title={label}
          data-testid="composer-options"
          className="size-7 rounded-[7px] text-muted-foreground pointer-coarse:size-11"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        collisionPadding={12}
        className="flex w-auto flex-wrap items-center gap-1 p-1.5"
        data-testid="composer-options-panel"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
