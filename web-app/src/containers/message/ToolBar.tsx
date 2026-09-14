import { cn } from '@/lib/utils'

/** Blinking block that reads as the model typing into the bar. */
export const Caret = () => (
  <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] motion-safe:animate-pulse bg-foreground" />
)

export type ToolBarProps = {
  icon: React.ReactNode
  value: string
  placeholder: string
  /** Show the caret: the model is still writing this argument. */
  typing: boolean
  mono?: boolean
  trailing?: React.ReactNode
  /** When set, the value becomes a button that opens what the bar names. */
  onActivate?: () => void
  activateLabel?: string
}

/**
 * Input-bar chrome shared by the native tool widgets, so a web search reads as
 * a search bar and a fetch as an address bar. The value is whatever has
 * streamed in so far, which is why the caret matters.
 */
export const ToolBar = ({
  icon,
  value,
  placeholder,
  typing,
  mono,
  trailing,
  onActivate,
  activateLabel,
}: ToolBarProps) => {
  const label = (
    <>
      {value || placeholder}
      {typing && <Caret />}
    </>
  )
  const className = cn(
    'min-w-0 flex-1 truncate text-left text-sm',
    mono && 'font-mono text-xs',
    !value && 'text-muted-foreground'
  )
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      {onActivate ? (
        <button
          type="button"
          onClick={onActivate}
          title={activateLabel}
          aria-label={activateLabel ? `${activateLabel}: ${value}` : undefined}
          className={cn(className, 'cursor-pointer hover:underline')}
        >
          {label}
        </button>
      ) : (
        <span className={className}>{label}</span>
      )}
      {trailing}
    </div>
  )
}
