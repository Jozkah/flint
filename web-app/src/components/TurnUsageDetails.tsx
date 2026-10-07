import { useTranslation } from '@/i18n/react-i18next-compat'
import { Gauge } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { TokenUsageBreakdown } from '@/components/TokenUsageBreakdown'
import { CacheReuseBadge } from '@/components/CacheReuseBadge'
import type { TokenUsage } from '@/lib/tokenUsage'
import type { TurnMemory } from '@/types/coworkSession'

/** `text` with the first `token` set in the mono face, as ids are elsewhere. */
function withMono(text: string, token: string) {
  const at = text.indexOf(token)
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <span className="font-mono">{token}</span>
      {text.slice(at + token.length)}
    </>
  )
}

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
  const { t } = useTranslation()
  const hasUsage = !!usage && (usage.totalTokens ?? 0) > 0
  const injected = memory?.injectedIds ?? []
  const withheld = memory?.conflictIds ?? []
  const issues = memory?.storageIssues ?? []
  const recallOff = memory?.recallOff ?? []
  const overridden = memory?.overridden ?? []
  const refused = memory?.refused ?? []
  const hasMemoryNote =
    injected.length > 0 ||
    withheld.length > 0 ||
    issues.length > 0 ||
    recallOff.length > 0 ||
    overridden.length > 0 ||
    refused.length > 0
  if (!hasUsage && !hasMemoryNote) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('common:a11y.turnUsageAndMemory')}
          data-testid="turn-usage-trigger"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:text-foreground"
        >
          <Gauge size={14} />
          {hasUsage && <span className="tabular-nums">{usage.totalTokens?.toLocaleString()}</span>}
          {hasUsage && (
            <CacheReuseBadge usage={usage} hideUnreported testId="turn-cache-status" />
          )}
          {injected.length > 0 && (
            <span>
              · {t('common:usage.memoryCount', { count: injected.length })}
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
        {hasMemoryNote && (
          <div
            className={hasUsage ? 'mt-2 border-t border-border pt-2' : undefined}
            data-testid="turn-memory"
          >
            <div className="font-medium text-foreground">{t('common:usage.memoryHeading')}</div>
            {injected.length > 0 ? (
              <ul className="mt-1 space-y-0.5" aria-label={t('common:a11y.memoriesSent')}>
                {injected.map((id) => {
                  const why = memory?.recall?.find((r) => r.id === id)
                  return (
                    <li key={id} data-memory-id={id}>
                      <span className="font-mono break-all">{id}</span>
                      {why && (
                        <span className="block text-muted-foreground" data-testid="turn-memory-reason">
                          #{why.rank} · {why.reason}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-1 text-muted-foreground">{t('common:usage.noMemory')}</p>
            )}
            {withheld.length > 0 && (
              <p className="mt-1 text-warning" data-testid="turn-memory-withheld">
                {t('common:usage.withheld', { ids: withheld.join(', ') })}
              </p>
            )}
            {overridden.map((o) => (
              <div
                key={`o-${o.memoryId}`}
                className="mt-1 text-warning"
                data-testid="turn-memory-overridden"
                data-memory-id={o.memoryId}
              >
                <p>
                  {withMono(
                    t('common:usage.overridden', { id: o.memoryId, winner: o.winnerName, subject: o.subject }),
                    o.memoryId
                  )}
                </p>
                <p className="text-muted-foreground">{t('common:usage.memorySays', { text: o.memorySays })}</p>
                <p className="text-muted-foreground">
                  {t('common:usage.winnerSays', { winner: o.winnerName, text: o.winnerSays })}
                </p>
              </div>
            ))}
            {refused.map((r) => (
              <p
                key={`r-${r.memoryId}`}
                className="mt-1 text-destructive"
                data-testid="turn-memory-refused"
              >
                {withMono(t('common:usage.refused', { id: r.memoryId, reason: r.reason }), r.memoryId)}
              </p>
            ))}
            {recallOff.length > 0 && (
              <p className="mt-1 text-muted-foreground" data-testid="turn-memory-recall-off">
                {t('common:usage.recallOff', { ids: recallOff.join(', ') })}
              </p>
            )}
            {issues.length > 0 && (
              <div role="alert" className="mt-1 text-destructive" data-testid="turn-memory-storage-error">
                {issues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
