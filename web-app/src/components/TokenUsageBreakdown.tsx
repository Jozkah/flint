import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ArrowDown, ArrowUp, Info, Sigma } from 'lucide-react'
import { CacheReuseBadge } from '@/components/CacheReuseBadge'
import {
  cacheSourceLabel,
  usageValueKinds,
  type TokenUsage,
  type UsageValueKind,
} from '@/lib/tokenUsage'

/** Why "Uncached input" is not a count of cache misses. */
export const UNCACHED_INPUT_NOTE =
  'Derived: input tokens minus cached input tokens. This is a token count, not a number of cache-miss events.'

export const CACHE_UNREPORTED_NOTE =
  'The provider did not report prompt-cache usage for this request, so no cached or uncached split is shown.'

export const CACHE_WRITE_NOTE =
  'Tokens the provider wrote to its prompt cache. They are part of the uncached input and are not counted again in the total.'

const KIND_LABEL: Record<UsageValueKind, string> = {
  reported: 'reported',
  derived: 'derived',
  clamped: 'clamped',
}

const formatExact = (num: number) => num.toLocaleString()

/**
 * The detailed token breakdown shown in the counter's popover and beside each
 * message, for Chat and Cowork alike.
 *
 * A row is drawn only for a count the provider reported, or one derived from
 * reported counts, and says which it is. When the cache was not reported, a
 * single "Not reported" row says so rather than showing a cached figure of
 * zero that nobody measured. Nothing here is an estimate: Flint's own payload
 * estimate (AH-073) is a separate record and is never shown as usage.
 */
export function TokenUsageBreakdown({
  usage,
  scope,
  className,
  testIdPrefix = 'token-usage',
}: {
  usage: TokenUsage
  /** The thread or session these numbers belong to. */
  scope?: string
  className?: string
  /** Distinguishes a per-message breakdown from the counter's. */
  testIdPrefix?: string
}) {
  const input = usage.inputTokens
  const cached = usage.cachedInputTokens
  const uncached = usage.uncachedInputTokens
  const cacheWrite = usage.cacheWriteTokens
  const cacheKnown = cached !== undefined
  const kinds = usageValueKinds(usage)
  const source = cacheSourceLabel(usage.cacheSource)
  const id = (name: string) => `${testIdPrefix}-${name}`

  return (
    <div
      className={cn('space-y-1.5 min-w-0', className)}
      role="group"
      aria-label="Token usage for this request"
      data-testid={id('breakdown')}
      data-usage-scope={scope}
    >
      {input !== undefined && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Prompt cache</span>
          <CacheReuseBadge usage={usage} testId={id('cache-status')} />
        </div>
      )}
      {usage.requests !== undefined && usage.requests > 1 && (
        <div
          className="text-[11px] text-muted-foreground"
          data-testid={id('cache-requests')}
          data-requests={usage.requests}
          data-cache-hit-requests={usage.cacheHitRequests}
        >
          {usage.requests} requests
          {usage.cacheHitRequests !== undefined &&
            ` · cache reused on ${usage.cacheHitRequests}`}
          {usage.cacheReportedRequests !== undefined &&
            usage.cacheReportedRequests < usage.requests &&
            ` · ${usage.requests - usage.cacheReportedRequests} did not report the cache`}
        </div>
      )}
      {input !== undefined && (
        <Row
          testId={id('input')}
          icon={<ArrowUp className="size-3.5" aria-hidden />}
          label="Input"
          value={input}
          kind={kinds.input}
        />
      )}

      {cacheKnown && input !== undefined && input > 0 && (
        <CacheBar
          cached={cached}
          uncached={uncached ?? 0}
          testId={id('cache-bar')}
        />
      )}

      {cacheKnown ? (
        <>
          <Row
            testId={id('cached')}
            swatch="bg-chart-1"
            label="Cached input"
            value={cached}
            kind={kinds.cached}
            title="Read from the provider's prompt cache"
            indent
          />
          {uncached !== undefined && (
            <Row
              testId={id('uncached')}
              swatch="bg-chart-3"
              label="Uncached input"
              value={uncached}
              kind={kinds.uncached}
              note={UNCACHED_INPUT_NOTE}
              indent
            />
          )}
        </>
      ) : (
        input !== undefined && (
          <Row
            testId={id('cache-unreported')}
            label="Cached input"
            text="Not reported"
            title={CACHE_UNREPORTED_NOTE}
            muted
            indent
          />
        )
      )}

      {cacheWrite !== undefined && (
        <Row
          testId={id('cache-write')}
          swatch="bg-chart-2"
          label="Cache write"
          value={cacheWrite}
          kind={kinds.cacheWrite}
          note={CACHE_WRITE_NOTE}
          indent={cacheKnown ? 2 : 1}
        />
      )}

      {usage.outputTokens !== undefined && (
        <Row
          testId={id('output')}
          icon={<ArrowDown className="size-3.5" aria-hidden />}
          label="Output"
          value={usage.outputTokens}
          kind={kinds.output}
        />
      )}

      {usage.totalTokens !== undefined && (
        <Row
          testId={id('total')}
          icon={<Sigma className="size-3.5" aria-hidden />}
          label="Total"
          value={usage.totalTokens}
          kind={kinds.total}
          strong
        />
      )}

      {usage.reported && (
        <div
          className="text-[11px] leading-snug text-warning"
          data-testid={id('clamped')}
          role="note"
        >
          The provider reported inconsistent cache counts
          {usage.reported.cachedInputTokens !== undefined &&
            ` (cached ${formatExact(usage.reported.cachedInputTokens)})`}
          {usage.reported.cacheWriteTokens !== undefined &&
            ` (cache write ${formatExact(usage.reported.cacheWriteTokens)})`}
          ; the values above were clamped to the input.
        </div>
      )}

      {source && (
        <div
          className="text-[10px] leading-snug text-muted-foreground break-words"
          data-testid={id('source')}
        >
          Cache figures reported via {source}
        </div>
      )}
    </div>
  )
}

/** Cached against freshly processed input, as one bar. */
function CacheBar({
  cached,
  uncached,
  testId,
}: {
  cached: number
  uncached: number
  testId: string
}) {
  const whole = cached + uncached
  if (whole <= 0) return null
  const cachedPct = (cached / whole) * 100
  return (
    <div
      className="ml-5 flex h-1.5 overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
      data-testid={testId}
    >
      <div className="h-full bg-chart-1" style={{ width: `${cachedPct}%` }} />
      <div
        className="h-full bg-chart-3"
        style={{ width: `${100 - cachedPct}%` }}
      />
    </div>
  )
}

function Row({
  testId,
  icon,
  swatch,
  label,
  value,
  text,
  title,
  note,
  kind,
  strong,
  muted,
  indent,
}: {
  testId: string
  icon?: React.ReactNode
  swatch?: string
  label: string
  value?: number
  text?: string
  title?: string
  note?: string
  kind?: UsageValueKind
  strong?: boolean
  muted?: boolean
  indent?: boolean | 1 | 2
}) {
  const depth = indent === true ? 1 : indent || 0
  const shown = value !== undefined ? formatExact(value) : text
  return (
    <div
      className="flex items-center justify-between gap-3 text-xs"
      data-testid={testId}
      data-value={value}
      data-kind={kind}
      title={title}
      aria-label={`${label}: ${shown}${kind ? ` (${KIND_LABEL[kind]})` : ''}`}
    >
      <span
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-muted-foreground',
          depth === 1 && 'pl-5',
          depth === 2 && 'pl-9'
        )}
      >
        {icon}
        {swatch && (
          <span
            className={cn('inline-block size-2 shrink-0 rounded-full', swatch)}
            aria-hidden="true"
          />
        )}
        <span className="truncate">{label}</span>
        {note && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                aria-label={note}
                data-testid={`${testId}-note`}
              >
                <Info className="size-3" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              className="max-w-56 bg-background text-foreground border"
              showArrow={false}
            >
              {note}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        {kind && kind !== 'reported' && (
          <span
            className={cn(
              'text-xs font-medium',
              kind === 'clamped' ? 'text-warning' : 'text-muted-foreground'
            )}
            aria-hidden="true"
          >
            {KIND_LABEL[kind]}
          </span>
        )}
        <span
          className={cn(
            'font-mono tabular-nums',
            muted ? 'text-muted-foreground italic' : 'text-foreground',
            strong && 'font-semibold'
          )}
        >
          {shown}
        </span>
      </span>
    </div>
  )
}
