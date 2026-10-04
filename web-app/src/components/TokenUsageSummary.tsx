import { Info } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatPercent } from '@/components/CacheReuseBadge'
import {
  cacheReusePercent,
  cacheStatus,
  usageValueKinds,
  type CacheReportSource,
  type TokenUsage,
} from '@/lib/tokenUsage'
import type { SpeedSource } from '@/lib/tokenSpeed'
import { costBreakdown, formatUsd, isFree, type Pricing } from '@/lib/modelPricing'

export type UsageSpeed = {
  last?: number
  average?: number
  source?: SpeedSource
  /** How many replies the average is over. */
  samples?: number
}

const exact = (n: number) => n.toLocaleString()

const SOURCE_NAME: Record<CacheReportSource, string> = {
  'openai-chat': "the provider's usage report",
  'openai-responses': "the provider's usage report",
  anthropic: "Anthropic's usage report",
  google: "Gemini's usage report",
  'engine-timings': "the local engine's timings",
}

const SPEED_NOTE: Record<SpeedSource, string> = {
  server: 'Measured by the server while it generated the reply.',
  measured:
    'Output tokens counted by the provider, over the time output was arriving. Waiting for the first token is not included.',
  estimated:
    'Estimated: the provider did not count output tokens, so they are taken from the text (about 4 characters per token).',
}

export function InfoTip({ note, testId }: { note: string; testId?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
          aria-label={note}
          data-testid={testId}
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
  )
}

/** One figure with its label above it: the three big numbers of a group. */
function Tile({
  testId,
  label,
  value,
  note,
  data,
}: {
  testId: string
  label: string
  value: string
  note?: string
  data?: Record<string, string | number | undefined>
}) {
  return (
    <div className="min-w-0" data-testid={testId} {...data}>
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {note && <InfoTip note={note} testId={`${testId}-note`} />}
      </div>
      <div className="mt-1 truncate font-mono text-base font-medium tabular-nums text-foreground">
        {value}
      </div>
    </div>
  )
}

/** A quieter figure on its own line, as in the chat message's speed popover. */
function Line({
  testId,
  label,
  value,
  note,
  data,
}: {
  testId: string
  label: string
  value: string
  note?: string
  data?: Record<string, string | number | undefined>
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 text-xs"
      data-testid={testId}
      {...data}
    >
      <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
        <span className="truncate">{label}</span>
        {note && <InfoTip note={note} testId={`${testId}-note`} />}
      </span>
      <span className="shrink-0 text-right font-mono tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function SplitItem({
  testId,
  swatch,
  label,
  tokens,
  percent,
}: {
  testId: string
  swatch: string
  label: string
  tokens: number
  percent: number
}) {
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={testId} data-value={tokens}>
      <span className={`size-1.5 rounded-full ${swatch}`} aria-hidden />
      {label}
      <span className="font-mono tabular-nums text-foreground">{exact(tokens)}</span>
      <span className="tabular-nums">{`(${formatPercent(percent)})`}</span>
    </span>
  )
}

/**
 * What a group of requests cost, by kind, and what the prompt cache saved.
 * Only drawn for a model with a price; a free (local) model has no cost to show.
 */
function CostBlock({ usage, pricing, prefix }: { usage: TokenUsage; pricing: Pricing; prefix: string }) {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null
  const cost = costBreakdown(pricing, usage)
  const hasCached = (usage.cachedInputTokens ?? 0) > 0
  const hasWrite = (usage.cacheWriteTokens ?? 0) > 0
  const fullRate = hasCached && !cost.cachedPriced
  const writeFullRate = hasWrite && !cost.writePriced
  const rows: { id: string; label: string; value: number; show: boolean }[] = [
    { id: 'cached', label: 'Cached input', value: cost.cachedInput, show: usage.cachedInputTokens !== undefined },
    { id: 'new', label: 'New input', value: cost.newInput, show: true },
    { id: 'write', label: 'Cache write', value: cost.cacheWrite, show: hasWrite },
    { id: 'output', label: 'Output', value: cost.output, show: true },
  ]
  const note = [
    fullRate ? 'Cached input priced at the full input rate (no cached price set).' : '',
    writeFullRate ? 'Cache writes priced at the full input rate (no cache write price set).' : '',
    'Estimated from the model price and the tokens the provider reported.',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="space-y-1.5" data-testid={`${prefix}-cost`} data-cached-full-rate={fullRate ? 'true' : undefined}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        Cost
        <InfoTip note={note} testId={`${prefix}-cost-note`} />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
        {rows
          .filter((r) => r.show)
          .map((r) => (
            <div key={r.id} data-testid={`${prefix}-cost-${r.id}`} data-value={r.value}>
              <div className="text-[11px] text-muted-foreground">{r.label}</div>
              <div className="font-mono text-xs tabular-nums text-foreground">{formatUsd(r.value)}</div>
            </div>
          ))}
      </div>
      <div
        className="flex items-center justify-between gap-4 border-t border-border pt-1.5 text-xs font-medium"
        data-testid={`${prefix}-cost-total`}
        data-value={cost.total}
      >
        <span className="text-foreground">Total</span>
        <span className="font-mono tabular-nums text-foreground">{formatUsd(cost.total)}</span>
      </div>
      {(fullRate || writeFullRate) && (
        <div className="text-[11px] leading-snug text-muted-foreground" data-testid={`${prefix}-cost-fullrate`}>
          {fullRate
            ? 'Cached input priced at the full input rate (no cached price set).'
            : 'Cache writes priced at the full input rate (no write price set).'}
        </div>
      )}
      {cost.savings > 0 && (
        <div className="text-[11px] text-muted-foreground" data-testid={`${prefix}-cost-saved`} data-value={cost.savings}>
          {`Saved ${formatUsd(cost.savings)} (${formatPercent(cost.savingsPercent)}) by caching`}
          <span className="ml-1 inline-flex align-middle">
            <InfoTip
              note="What the cached tokens would have cost at the full input price, minus what they cost. The percentage is of what the whole reply would have cost without caching."
              testId={`${prefix}-cost-saved-note`}
            />
          </span>
        </div>
      )}
    </div>
  )
}

/** The cache line under the figures: a thin bar, and how much of the input it was. */
function CacheLine({
  usage,
  prefix,
  aggregate,
}: {
  usage: TokenUsage
  prefix: string
  /** Several requests added up, so the share is over the ones that reported. */
  aggregate?: boolean
}) {
  const input = usage.inputTokens
  if (input === undefined) return null
  const cached = usage.cachedInputTokens
  const uncached = usage.uncachedInputTokens
  const status = cacheStatus(usage)
  const pct = cacheReusePercent(usage)
  const reused = usage.cacheHitRequests
  const requests = usage.requests
  const split =
    cached !== undefined && uncached !== undefined
      ? `${exact(cached)} read from the cache, ${exact(uncached)} new.`
      : ''
  const several =
    requests !== undefined && requests > 1 && reused !== undefined
      ? ` The cache was reused on ${reused} of ${requests} requests.`
      : ''
  const clamped =
    usage.reported?.cachedInputTokens !== undefined
      ? ` The provider reported ${exact(usage.reported.cachedInputTokens)} cached, more than the input; it was cut to fit.`
      : ''
  const written =
    usage.cacheWriteTokens !== undefined
      ? ` ${exact(usage.cacheWriteTokens)} written to the cache (part of the new input).`
      : ''
  const via = usage.cacheSource ? ` Reported by ${SOURCE_NAME[usage.cacheSource]}.` : ''
  const reportedOf =
    aggregate && requests !== undefined && requests > 1 && usage.cacheReportedRequests !== undefined
      ? usage.cacheReportedRequests
      : undefined
  const partial =
    reportedOf !== undefined && reportedOf > 0 && requests !== undefined && reportedOf < requests
      ? ` Only ${reportedOf} of ${requests} requests reported cache info; the share is of their input.`
      : ''
  const cacheNote =
    status === 'not-reported'
      ? aggregate
        ? 'No request reported prompt-cache use.'
        : 'The provider did not report prompt-cache use for this request.'
      : pct === undefined
        ? `The share cannot be worked out from what was saved.${several}${partial}`.trim()
        : `${split}${written}${several}${partial}${clamped}${via}`.trim()
  const whole = (cached ?? 0) + (uncached ?? 0)
  const write = Math.min(usage.cacheWriteTokens ?? 0, uncached ?? 0)
  const fresh = Math.max((uncached ?? 0) - write, 0)
  const share = (n: number) => (whole > 0 ? (n / whole) * 100 : 0)
  // A share, or a dash: never the bare word.
  const showDash = status === 'not-reported' ? aggregate : pct === undefined

  return (
    <div
      className="space-y-2"
      data-testid={`${prefix}-input`}
      data-value={input}
      data-cached={cached}
      data-uncached={uncached}
      data-cache-write={usage.cacheWriteTokens}
    >
      {cached !== undefined && whole > 0 && input > 0 && (
        <div
          className="flex h-1.5 overflow-hidden rounded-full bg-track"
          aria-hidden="true"
          data-testid={`${prefix}-cache-bar`}
        >
          <div className="h-full bg-chart-1" style={{ width: `${share(cached)}%` }} />
          {write > 0 && <div className="h-full bg-chart-2" style={{ width: `${share(write)}%` }} />}
          <div className="h-full bg-chart-3" style={{ width: `${share(fresh)}%` }} />
        </div>
      )}
      {cached !== undefined && whole > 0 && (
        <div
          className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground"
          data-testid={`${prefix}-cache-split`}
        >
          <SplitItem testId={`${prefix}-cache-split-cached`} swatch="bg-chart-1" label="Cached" tokens={cached} percent={share(cached)} />
          <SplitItem testId={`${prefix}-cache-split-new`} swatch="bg-chart-3" label="New" tokens={fresh} percent={share(fresh)} />
          {write > 0 && (
            <SplitItem testId={`${prefix}-cache-split-write`} swatch="bg-chart-2" label="Written" tokens={write} percent={share(write)} />
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          Prompt cache
          <InfoTip note={cacheNote} testId={`${prefix}-cache-note`} />
        </span>
        {showDash ? (
          <span
            className="font-mono tabular-nums text-foreground"
            data-testid={`${prefix}-cache-status`}
            data-cache-status={status}
            aria-label="Cache share unavailable"
          >
            -
          </span>
        ) : status !== 'not-reported' ? (
          <span
            className="font-mono tabular-nums text-foreground"
            data-testid={`${prefix}-cache-status`}
            data-cache-status={status}
            data-cache-percent={pct !== undefined ? pct.toFixed(2) : undefined}
          >
            {`${formatPercent(pct ?? 0)} cached`}
          </span>
        ) : (
          <span
            data-testid={`${prefix}-cache-status`}
            data-cache-status={status}
            aria-label="Cache use not reported"
          >
            Not reported
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * One group of numbers: input (with how much of it was cached), output, speed
 * and total. Where a figure came from lives in its info tooltip, not in text
 * beside it.
 */
function Group({
  usage,
  speed,
  speedValue,
  prefix,
  aggregate,
  pricing,
}: {
  usage: TokenUsage
  speed?: UsageSpeed
  speedValue?: number
  prefix: string
  /** The conversation's group: sums over requests, and an average speed. */
  aggregate?: boolean
  /** A price to show the cost at; absent or free draws no cost. */
  pricing?: Pricing | null
}) {
  const kinds = usageValueKinds(usage)
  const estimated = !aggregate && speed?.source === 'estimated'
  // Always the sum of its two parts, whatever a provider called its total.
  const total =
    usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : usage.totalTokens
  const requests = usage.requests
  const speedNote = aggregate
    ? `All output tokens over all generation time, across ${
        speed?.samples === undefined
          ? 'the replies'
          : `${speed.samples} ${speed.samples === 1 ? 'reply' : 'replies'}${
              requests !== undefined && requests > speed.samples ? ` of ${requests} requests` : ''
            }`
      } with both a token count and a decode time.`
    : speed?.source
      ? SPEED_NOTE[speed.source]
      : undefined
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {usage.inputTokens !== undefined && (
          <Tile
            testId={`${prefix}-input-value`}
            label="Input"
            value={exact(usage.inputTokens)}
          />
        )}
        {usage.outputTokens !== undefined && (
          <Tile
            testId={`${prefix}-output`}
            label="Output"
            value={exact(usage.outputTokens)}
            data={{ 'data-value': usage.outputTokens }}
          />
        )}
        {total !== undefined && (
          <Tile
            testId={`${prefix}-total`}
            label="Total"
            value={exact(total)}
            note={
              aggregate
                ? 'Input plus output, added up over all requests. Cached input counts as input each time it is sent.'
                : kinds.total === 'derived'
                  ? 'Input plus output.'
                  : undefined
            }
            data={{ 'data-value': total }}
          />
        )}
      </div>
      <CacheLine usage={usage} prefix={prefix} aggregate={aggregate} />
      {pricing && !isFree(pricing) && <CostBlock usage={usage} pricing={pricing} prefix={prefix} />}
      {speedValue !== undefined && (
        <Line
          testId={`${prefix}-speed`}
          label="Speed"
          value={`${estimated ? '~' : ''}${speedValue >= 100 ? Math.round(speedValue) : speedValue.toFixed(1)} tok/s`}
          note={speedNote}
          data={{
            'data-value': speedValue,
            'data-source': speed?.source,
            'data-samples': aggregate ? speed?.samples : undefined,
          }}
        />
      )}
    </div>
  )
}

/**
 * What the counter's popover shows under the context window: the last reply's
 * numbers, then the conversation's, in the same four rows. The speed of the
 * last reply is the latest; of the conversation, the average.
 */
export function TokenUsageSummary({
  usage,
  session,
  speed,
  scope,
  pricing,
  onSetPrice,
}: {
  usage: TokenUsage
  session?: TokenUsage
  speed?: UsageSpeed
  scope?: string
  /**
   * The model's price, to show what the replies cost. `undefined` leaves cost
   * out; `null` says the model has no price and offers to set one; a free
   * (local) model shows neither.
   */
  pricing?: Pricing | null
  /** Opens the provider settings where a model's price is set. */
  onSetPrice?: () => void
}) {
  const requests = session?.requests ?? 0
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined
  ) {
    return (
      <p
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid="token-usage-empty"
        data-usage-scope={scope}
      >
        No reply details yet.
      </p>
    )
  }
  return (
    <div className="divide-y divide-border" data-testid="token-usage-breakdown" data-usage-scope={scope}>
      <section className="space-y-3 px-4 py-4" aria-label="Last reply">
        <div className="text-xs font-medium text-foreground">Last reply</div>
        <Group usage={usage} speed={speed} speedValue={speed?.last} prefix="token-usage" pricing={pricing} />
      </section>
      {session && requests > 1 && (
        <section
          className="space-y-3 px-4 py-4"
          aria-label="This conversation"
          data-testid="session-usage"
          data-usage-scope={scope}
          data-requests={session.requests}
          data-cache-hit-requests={session.cacheHitRequests}
        >
          <div className="text-xs font-medium text-foreground">
            This conversation
            <span className="font-normal text-muted-foreground">
              {` · All requests (${requests})`}
            </span>
          </div>
          <Group
            usage={session}
            speed={speed}
            speedValue={speed?.average}
            prefix="session-token-usage"
            aggregate
            pricing={pricing}
          />
        </section>
      )}
      {pricing === null && (
        <section className="px-4 py-3" data-testid="cost-no-price">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {onSetPrice ? (
              <button
                type="button"
                onClick={onSetPrice}
                className="underline underline-offset-2 hover:text-foreground focus-visible:text-foreground"
                data-testid="cost-set-price"
              >
                Set a price to see cost
              </button>
            ) : (
              <span>Set a price to see cost</span>
            )}
            <InfoTip
              note="This model has no price. Add one on the model in provider settings (input and output, plus cached input and cache write if the provider charges differently)."
              testId="cost-no-price-note"
            />
          </div>
        </section>
      )}
    </div>
  )
}
