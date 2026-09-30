import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn, formatTokenCount } from '@/lib/utils'
import type { ContextSegment } from '@/lib/contextBreakdown'

/** A share (0 to 1) as a percentage; anything under a tenth of a percent says so. */
const pctText = (share: number) => {
  const pct = share * 100
  return pct >= 0.1 ? `${pct.toFixed(1)}%` : pct > 0 ? '<0.1%' : '0%'
}

type Row = {
  key: string
  label: string
  tokens: number
  color: string
  children?: ContextSegment['children']
}

/**
 * The context window as a coloured bar with the reasons it is that full.
 *
 * Collapsed it is one line, the bar and what is left before the conversation
 * compacts itself. Expanded, every kind of thing in the window gets a row with
 * its share, and a row made of parts (each MCP server, each tool) opens onto
 * them. The figures are estimates of what the last request carried; the total
 * is the provider's own when it reported one.
 */
export function ContextWindowCard({
  segments,
  usedTokens,
  windowTokens,
  autoCompactBuffer,
  autoCompactOn,
  onCompact,
  defaultExpanded = false,
}: {
  segments: readonly ContextSegment[]
  usedTokens: number
  /** The model's window, when known. Without it the bar is shares of what is used. */
  windowTokens?: number
  /** Tokens held back for compaction to run in, when auto-compact is on. */
  autoCompactBuffer?: number
  autoCompactOn?: boolean
  onCompact?: () => void
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const hasWindow = !!windowTokens && windowTokens > 0
  const buffer = hasWindow && autoCompactOn ? (autoCompactBuffer ?? 0) : 0
  const free = hasWindow ? Math.max(0, windowTokens - usedTokens - buffer) : 0
  // The bar's whole: the window, or (no window known) what is in use.
  const whole = hasWindow ? Math.max(windowTokens, usedTokens) : Math.max(usedTokens, 1)
  const untilCompact =
    hasWindow && autoCompactOn ? Math.max(0, windowTokens - buffer - usedTokens) : null

  const rows: Row[] = [
    ...segments.map((s) => ({
      key: s.id,
      label: s.label,
      tokens: s.tokens,
      color: s.color,
      children: s.children,
    })),
    ...(buffer > 0
      ? [{ key: 'buffer', label: 'Autocompact buffer', tokens: buffer, color: 'bg-zinc-500' }]
      : []),
    ...(hasWindow
      ? [{ key: 'free', label: 'Free space', tokens: free, color: 'bg-zinc-700' }]
      : []),
  ]

  const usedPct = hasWindow ? Math.min(100, (usedTokens / windowTokens) * 100) : undefined

  return (
    <div className="text-xs" data-testid="context-window-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 pt-3 text-left"
      >
        <span className="shrink-0 whitespace-nowrap font-medium text-foreground">Context window</span>
        <span className="ml-auto flex items-center gap-1 whitespace-nowrap tabular-nums text-muted-foreground">
          {hasWindow
            ? `${formatTokenCount(usedTokens)} / ${formatTokenCount(windowTokens)} (${usedPct!.toFixed(0)}%)`
            : `${formatTokenCount(usedTokens)} tokens`}
          <ChevronDown
            className={cn('size-3.5 transition-transform', expanded ? '' : '-rotate-90')}
            aria-hidden
          />
        </span>
      </button>

      <div className="px-3 pt-2">
        <div
          className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label="Context window usage by kind"
          data-testid="context-bar"
        >
          {segments.map((s) => (
            <div
              key={s.id}
              className={cn('h-full shrink-0', s.color)}
              style={{ width: `${(s.tokens / whole) * 100}%` }}
              title={`${s.label}: ${formatTokenCount(s.tokens)}`}
              data-segment={s.id}
            />
          ))}
          {buffer > 0 && (
            <div
              className="ml-auto h-full shrink-0 bg-zinc-500/60"
              style={{ width: `${(buffer / whole) * 100}%` }}
              data-segment="buffer"
            />
          )}
        </div>
      </div>

      {(untilCompact !== null || onCompact) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 pt-3 text-muted-foreground">
          <span data-testid="until-compact" className="min-w-0">
            {untilCompact !== null
              ? `${formatTokenCount(untilCompact)} until auto-compact`
              : autoCompactOn === false
                ? 'Auto-compact is off'
                : ''}
          </span>
          {onCompact && (
            <button
              type="button"
              onClick={onCompact}
              className="ml-auto shrink-0 whitespace-nowrap rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
            >
              Compact session
            </button>
          )}
        </div>
      )}

      {expanded && (
        <ul className="mt-2 space-y-0.5 border-t border-border px-3 pt-2" data-testid="context-legend">
          {rows.map((row) => {
            const expandable = !!row.children && row.children.length > 0
            const isOpen = !!open[row.key]
            const share = row.tokens / whole
            return (
              <li key={row.key}>
                <div className="flex items-center gap-2 py-0.5">
                  <span
                    aria-hidden
                    className={cn('size-2.5 shrink-0 rounded-[3px]', row.color)}
                  />
                  {expandable ? (
                    <button
                      type="button"
                      onClick={() => setOpen((o) => ({ ...o, [row.key]: !o[row.key] }))}
                      aria-expanded={isOpen}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left text-foreground"
                    >
                      <span className="truncate">{row.label}</span>
                      {isOpen ? (
                        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
                  )}
                  <span className="tabular-nums text-muted-foreground">
                    {formatTokenCount(row.tokens)}
                  </span>
                  <span className="w-12 text-right font-medium tabular-nums text-foreground">
                    {pctText(share)}
                  </span>
                </div>
                {expandable && isOpen && (
                  <ul className="mb-1 ml-[18px] space-y-0.5 border-l border-border pl-2.5">
                    {row.children!.map((child) => (
                      <li
                        key={child.label}
                        className="flex items-center justify-between gap-3 text-muted-foreground"
                      >
                        <span className="min-w-0 truncate">{child.label}</span>
                        <span className="tabular-nums">{formatTokenCount(child.tokens)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <p className="px-3 pb-2 pt-2 text-[10.5px] leading-snug text-muted-foreground">
        Estimated from what the last request carried (about 4 characters per token).
      </p>
    </div>
  )
}
