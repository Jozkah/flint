import { SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * The composer's less-used controls behind one button. Whatever is switched
 * on (web search, say) is named beside it, so a setting that changes the
 * answer is never hidden.
 */
export function ComposerOptionsMenu({
  label,
  active,
  children,
}: {
  label: string
  /** Names of options that are on, shown beside the button. */
  active: readonly string[]
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-1">
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
      {active.map((name) => (
        <span
          key={name}
          data-testid="composer-option-active"
          className="rounded-md bg-[color-mix(in_oklab,var(--primary)_12%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-foreground"
        >
          {name}
        </span>
      ))}
    </div>
  )
}
