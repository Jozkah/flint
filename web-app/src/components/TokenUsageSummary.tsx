import { useTranslation } from '@/i18n/react-i18next-compat'
import { Info } from 'lucide-react'
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
  'openai-chat': 'common:usage.source.provider',
  'openai-responses': 'common:usage.source.provider',
  anthropic: 'common:usage.source.anthropic',
  google: 'common:usage.source.google',
  'engine-timings': 'common:usage.source.engine',
}

const SPEED_NOTE: Record<SpeedSource, string> = {
  server: 'common:usage.speed.server',
  measured: 'common:usage.speed.measured',
  estimated: 'common:usage.speed.estimated',
}

export function InfoTip({ note, testId }: { note: string; testId?: string }) {
  return (
    <button
      type="button"
      className="inline-flex shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
      aria-label={note}
      title={note}
      data-testid={testId}
    >
      <Info className="size-3" aria-hidden />
    </button>
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
  const { t } = useTranslation()
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null
  const cost = costBreakdown(pricing, usage)
  const hasCached = (usage.cachedInputTokens ?? 0) > 0
  const hasWrite = (usage.cacheWriteTokens ?? 0) > 0
  const fullRate = hasCached && !cost.cachedPriced
  const writeFullRate = hasWrite && !cost.writePriced
  const rows: { id: string; label: string; value: number; show: boolean }[] = [
    { id: 'cached', label: t('common:usage.cachedInput'), value: cost.cachedInput, show: usage.cachedInputTokens !== undefined },
    { id: 'new', label: t('common:usage.cost.newInput'), value: cost.newInput, show: true },
    { id: 'write', label: t('common:usage.cacheWrite'), value: cost.cacheWrite, show: hasWrite },
    { id: 'output', label: t('common:usage.output'), value: cost.output, show: true },
  ]
  const note = [
    fullRate ? t('common:usage.cost.fullRateCached') : '',
    writeFullRate ? t('common:usage.cost.fullRateWrite') : '',
    t('common:usage.cost.estimated'),
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="space-y-1.5" data-testid={`${prefix}-cost`} data-cached-full-rate={fullRate ? 'true' : undefined}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {t('common:usage.cost.label')}
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
        <span className="text-foreground">{t('common:usage.total')}</span>
        <span className="font-mono tabular-nums text-foreground">{formatUsd(cost.total)}</span>
      </div>
      {(fullRate || writeFullRate) && (
        <div className="text-[11px] leading-snug text-muted-foreground" data-testid={`${prefix}-cost-fullrate`}>
          {fullRate
            ? t('common:usage.cost.fullRateCached')
            : t('common:usage.cost.fullRateWriteShort')}
        </div>
      )}
      {cost.savings > 0 && (
        <div className="text-[11px] text-muted-foreground" data-testid={`${prefix}-cost-saved`} data-value={cost.savings}>
          {t('common:usage.cost.saved', { amount: formatUsd(cost.savings), percent: formatPercent(cost.savingsPercent) })}
          <span className="ml-1 inline-flex align-middle">
            <InfoTip
              note={t('common:usage.cost.savedNote')}
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
  const { t } = useTranslation()
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
      ? t('common:usage.cache.split', { cached: exact(cached), uncached: exact(uncached) })
      : ''
  const several =
    requests !== undefined && requests > 1 && reused !== undefined
      ? t('common:usage.cache.several', { reused, requests })
      : ''
  const clamped =
    usage.reported?.cachedInputTokens !== undefined
      ? t('common:usage.cache.clamped', { cached: exact(usage.reported.cachedInputTokens) })
      : ''
  const written =
    usage.cacheWriteTokens !== undefined
      ? t('common:usage.cache.written', { written: exact(usage.cacheWriteTokens) })
      : ''
  const via = usage.cacheSource ? t('common:usage.cache.via', { source: t(SOURCE_NAME[usage.cacheSource]) }) : ''
  const reportedOf =
    aggregate && requests !== undefined && requests > 1 && usage.cacheReportedRequests !== undefined
      ? usage.cacheReportedRequests
      : undefined
  const partial =
    reportedOf !== undefined && reportedOf > 0 && requests !== undefined && reportedOf < requests
      ? t('common:usage.cache.partial', { reported: reportedOf, requests })
      : ''
  const cacheNote =
    status === 'not-reported'
      ? aggregate
        ? t('common:usage.cache.noneReported')
        : t('common:usage.cache.notReportedRequest')
      : pct === undefined
        ? `${t('common:usage.cache.shareUnknown')}${several}${partial}`.trim()
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
          <SplitItem testId={`${prefix}-cache-split-cached`} swatch="bg-chart-1" label={t('common:usage.cache.cached')} tokens={cached} percent={share(cached)} />
          <SplitItem testId={`${prefix}-cache-split-new`} swatch="bg-chart-3" label={t('common:usage.cache.new')} tokens={fresh} percent={share(fresh)} />
          {write > 0 && (
            <SplitItem testId={`${prefix}-cache-split-write`} swatch="bg-chart-2" label={t('common:usage.cache.written_label')} tokens={write} percent={share(write)} />
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          {t('common:usage.promptCache')}
          <InfoTip note={cacheNote} testId={`${prefix}-cache-note`} />
        </span>
        {showDash ? (
          <span
            className="font-mono tabular-nums text-foreground"
            data-testid={`${prefix}-cache-status`}
            data-cache-status={status}
            aria-label={t('common:a11y.cacheShareUnavailable')}
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
            {t('common:usage.cache.percentCached', { percent: formatPercent(pct ?? 0) })}
          </span>
        ) : (
          <span
            data-testid={`${prefix}-cache-status`}
            data-cache-status={status}
            aria-label={t('common:a11y.cacheNotReported')}
          >
            {t('common:usage.notReported')}
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
  const { t } = useTranslation()
  const kinds = usageValueKinds(usage)
  const estimated = !aggregate && speed?.source === 'estimated'
  // Always the sum of its two parts, whatever a provider called its total.
  const total =
    usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : usage.totalTokens
  const requests = usage.requests
  const speedNote = aggregate
    ? t('common:usage.speed.aggregate', {
        replies:
          speed?.samples === undefined
            ? t('common:usage.speed.theReplies')
            : `${t('common:usage.speed.replies', { count: speed.samples })}${
                requests !== undefined && requests > speed.samples
                  ? t('common:usage.speed.ofRequests', { requests })
                  : ''
              }`,
      })
    : speed?.source
      ? t(SPEED_NOTE[speed.source])
      : undefined
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {usage.inputTokens !== undefined && (
          <Tile
            testId={`${prefix}-input-value`}
            label={t('common:usage.input')}
            value={exact(usage.inputTokens)}
          />
        )}
        {usage.outputTokens !== undefined && (
          <Tile
            testId={`${prefix}-output`}
            label={t('common:usage.output')}
            value={exact(usage.outputTokens)}
            data={{ 'data-value': usage.outputTokens }}
          />
        )}
        {total !== undefined && (
          <Tile
            testId={`${prefix}-total`}
            label={t('common:usage.total')}
            value={exact(total)}
            note={
              aggregate
                ? t('common:usage.totalNoteAggregate')
                : kinds.total === 'derived'
                  ? t('common:usage.totalNoteDerived')
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
          label={t('common:usage.speed.label')}
          value={`${estimated ? '~' : ''}${t('common:usage.speed.unit', { value: speedValue >= 100 ? Math.round(speedValue) : speedValue.toFixed(1) })}`}
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
  const { t } = useTranslation()
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
        {t('common:usage.noDetails')}
      </p>
    )
  }
  return (
    <div className="divide-y divide-border" data-testid="token-usage-breakdown" data-usage-scope={scope}>
      <section className="space-y-3 px-4 py-4" aria-label={t('common:a11y.lastReply')}>
        <div className="text-xs font-medium text-foreground">{t('common:usage.lastReply')}</div>
        <Group usage={usage} speed={speed} speedValue={speed?.last} prefix="token-usage" pricing={pricing} />
      </section>
      {session && requests > 1 && (
        <section
          className="space-y-3 px-4 py-4"
          aria-label={t('common:a11y.thisConversation')}
          data-testid="session-usage"
          data-usage-scope={scope}
          data-requests={session.requests}
          data-cache-hit-requests={session.cacheHitRequests}
        >
          <div className="text-xs font-medium text-foreground">
            {t('common:usage.thisConversation')}
            <span className="font-normal text-muted-foreground">
              {t('common:usage.allRequests', { count: requests })}
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
                {t('common:usage.setPrice')}
              </button>
            ) : (
              <span>{t('common:usage.setPrice')}</span>
            )}
            <InfoTip
              note={t('common:usage.noPriceNote')}
              testId="cost-no-price-note"
            />
          </div>
        </section>
      )}
    </div>
  )
}
