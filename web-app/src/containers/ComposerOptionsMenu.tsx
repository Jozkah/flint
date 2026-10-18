import { SlidersHorizontal } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { WebSearchToggleRow, type WebSearchToggle } from '@/containers/WebSearchToggleRow'

/** The composer's less-used controls behind one compact icon button. */
export function ComposerOptionsMenu({
  label,
  children,
  webSearch,
}: {
  label: string
  /** Kept at call sites for compatibility; active state is visible in the panel. */
  active: readonly string[]
  children: ReactNode
  /** Web search for this session, as a row above the other options. */
  webSearch?: WebSearchToggle
}) {
  // The panel opens above the whole composer box, not above its own trigger:
  // anchored to the trigger it floated over the input text.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [box, setBox] = useState<HTMLElement | null>(null)
  return (
    <Popover
      onOpenChange={(open) =>
        setBox(
          open
            ? (triggerRef.current
                ?.closest<HTMLElement>('[data-composer-footer]')
                ?.parentElement?.querySelector<HTMLElement>('[data-composer-box]') ?? null)
            : null
        )
      }
    >
      {box && <PopoverAnchor virtualRef={{ current: box }} />}
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
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
        sideOffset={8}
        collisionPadding={12}
        // Focus the panel itself, not its first control: that control's tooltip
        // opened on focus and took the first Escape, so closing took two.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.target as HTMLElement | null)?.focus?.()
        }}
        className="flex w-auto min-w-64 flex-col gap-1 p-1.5"
        data-testid="composer-options-panel"
      >
        {webSearch && <WebSearchToggleRow {...webSearch} />}
        <div className="flex flex-wrap items-center gap-1">{children}</div>
      </PopoverContent>
    </Popover>
  )
}
