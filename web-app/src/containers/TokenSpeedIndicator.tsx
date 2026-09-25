import { memo } from 'react'
import { toNumber } from '@/utils/number'
import { Gauge } from 'lucide-react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { readTokenUsage } from '@/lib/tokenUsage'
import { TokenUsageBreakdown } from '@/components/TokenUsageBreakdown'
import { CacheReuseBadge } from '@/components/CacheReuseBadge'
import { isMeaningfulSpeed } from '@/lib/tokenSpeed'

interface TokenSpeedMeta {
  tokenSpeed: number
  promptSpeed?: number
  tokenCount?: number
  durationMs?: number
}

interface TokenSpeedIndicatorProps {
  metadata?: Record<string, unknown>
  streaming?: boolean
}

export const TokenSpeedIndicator = memo(
  ({ metadata, streaming }: TokenSpeedIndicatorProps) => {
    const showTokenSpeed = useInterfaceSettings((s) => s.showTokenSpeed)

    const nonStreamingAssistantParam =
      typeof metadata?.assistant === 'object' &&
      metadata?.assistant !== null &&
      'parameters' in metadata.assistant
        ? (metadata.assistant as { parameters?: { stream?: boolean } })
            .parameters?.stream === false
        : undefined

    if (nonStreamingAssistantParam) return null
    if (streaming) return null

    const persisted = metadata?.tokenSpeed as TokenSpeedMeta | undefined
    // This message's own usage, not the thread's latest: an earlier turn's
    // breakdown is shown for that turn.
    const usage = readTokenUsage(metadata?.usage)
    const hasBreakdown =
      !!usage && (usage.totalTokens ?? 0) > 0
    // Which remembered records this message's request carried (AH-083).
    const memory = metadata?.memory as
      | { injectedIds?: unknown; conflictIds?: unknown }
      | undefined
    const ids = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    const memoryIds = ids(memory?.injectedIds)
    const withheldIds = ids(memory?.conflictIds)
    const displayTokenCount = usage?.outputTokens ?? persisted?.tokenCount ?? 0
    const durationMs =
      typeof persisted?.durationMs === 'number' ? persisted.durationMs : undefined
    const rawSpeed = isMeaningfulSpeed(displayTokenCount, durationMs)
      ? toNumber(persisted?.tokenSpeed ?? 0)
      : 0
    const displaySpeed = Math.round(rawSpeed)
    const promptSpeed = persisted?.promptSpeed

    if (
      displaySpeed === 0 &&
      displayTokenCount === 0 &&
      !hasBreakdown &&
      memoryIds.length === 0 &&
      withheldIds.length === 0
    ) {
      return null
    }

    const details = (
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] p-3 text-xs"
        data-testid="message-token-details"
      >
        <div className="flex flex-col gap-1">
          {rawSpeed > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Generation</span>
              <span className="font-mono">{rawSpeed.toFixed(2)} tps</span>
            </div>
          )}
          {promptSpeed && promptSpeed > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Reading</span>
              <span className="font-mono">{promptSpeed.toFixed(2)} tps</span>
            </div>
          )}
          {hasBreakdown ? (
            <div
              className={
                rawSpeed > 0 || (promptSpeed ?? 0) > 0
                  ? 'mt-1.5 border-t border-border pt-2'
                  : undefined
              }
            >
              <TokenUsageBreakdown
                usage={usage}
                testIdPrefix="message-token-usage"
              />
            </div>
          ) : (
            displayTokenCount > 0 && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Tokens</span>
                <span className="font-mono">{displayTokenCount}</span>
              </div>
            )
          )}
          {(memoryIds.length > 0 || withheldIds.length > 0) && (
            <div
              className="mt-1.5 border-t border-border pt-2"
              data-testid="message-memory"
            >
              <div className="font-medium text-foreground">Memory in this request</div>
              <ul className="mt-1 space-y-0.5" aria-label="Memories sent">
                {memoryIds.map((id) => (
                  <li key={id} className="font-mono break-all" data-memory-id={id}>
                    {id}
                  </li>
                ))}
              </ul>
              {withheldIds.length > 0 && (
                <p className="mt-1 text-warning">
                  Withheld as conflicting: {withheldIds.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    )

    const trigger = (
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Token usage for this message"
          data-testid="message-token-trigger"
          className="text-muted-foreground cursor-pointer hover:text-foreground focus-visible:text-foreground transition-colors"
        >
          <Gauge size={16} />
        </button>
      </PopoverTrigger>
    )
    // Beside the trigger, not inside it: a per-message flag readable without
    // opening anything, only when the provider reported the cache.
    const cacheFlag = usage ? (
      <CacheReuseBadge usage={usage} hideUnreported testId="message-cache-status" />
    ) : null

    if (showTokenSpeed) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Popover>
            {trigger}
            {details}
          </Popover>
          {cacheFlag}
          {displaySpeed > 0 && <span>{displaySpeed} tokens/sec</span>}
          {displayTokenCount > 0 && (
            <span className="text-muted-foreground">
              ({displayTokenCount} tokens)
            </span>
          )}
        </div>
      )
    }

    return (
      <span className="inline-flex items-center gap-2">
        <Popover>
          {trigger}
          {details}
        </Popover>
        {cacheFlag}
      </span>
    )
  }
)

export default memo(TokenSpeedIndicator)
