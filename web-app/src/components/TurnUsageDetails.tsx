import { Gauge } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { TokenUsageBreakdown } from '@/components/TokenUsageBreakdown'
import type { TokenUsage } from '@/lib/tokenUsage'
import type { TurnMemory } from '@/types/coworkSession'

/**
 * One request's token breakdown and the memories it carried, for the turn it
 * produced. Collapsed behind a button so the transcript stays readable, and
 * keyboard-reachable like any other control.
 */
export function TurnUsageDetails({
  usage,
  memory,
}: {
  usage?: TokenUsage
  memory?: TurnMemory
}) {
  const hasUsage = !!usage && (usage.totalTokens ?? 0) > 0
  const injected = memory?.injectedIds ?? []
  const withheld = memory?.conflictIds ?? []
  if (!hasUsage && injected.length === 0 && withheld.length === 0) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Token usage and memory for this turn"
          data-testid="turn-usage-trigger"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:text-foreground"
        >
          <Gauge size={14} />
          {hasUsage && <span className="tabular-nums">{usage.totalTokens?.toLocaleString()}</span>}
          {injected.length > 0 && (
            <span>
              · {injected.length} {injected.length === 1 ? 'memory' : 'memories'}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] p-3 text-xs"
        data-testid="turn-usage-details"
      >
        {hasUsage && (
          <TokenUsageBreakdown usage={usage} testIdPrefix="turn-token-usage" />
        )}
        {(injected.length > 0 || withheld.length > 0) && (
          <div
            className={hasUsage ? 'mt-2 border-t border-border pt-2' : undefined}
            data-testid="turn-memory"
          >
            <div className="font-medium text-foreground">Memory in this request</div>
            {injected.length > 0 ? (
              <ul className="mt-1 space-y-0.5" aria-label="Memories sent">
                {injected.map((id) => (
                  <li key={id} className="font-mono break-all" data-memory-id={id}>
                    {id}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-muted-foreground">No memory was sent.</p>
            )}
            {withheld.length > 0 && (
              <p className="mt-1 text-amber-600" data-testid="turn-memory-withheld">
                Withheld as conflicting: {withheld.join(', ')}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
