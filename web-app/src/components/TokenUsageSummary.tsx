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

export type UsageSpeed = { last?: number; average?: number; source?: SpeedSource }

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

function InfoTip({ note, testId }: { note: string; testId?: string }) {
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

/** The cache line under the figures: a thin bar, and how much of the input it was. */
function CacheLine({ usage, prefix }: { usage: TokenUsage; prefix: string }) {
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
  const cacheNote =
    status === 'not-reported'
      ? 'The provider did not report prompt-cache use for this request.'
      : `${split}${written}${several}${clamped}${via}`.trim()
  const whole = (cached ?? 0) + (uncached ?? 0)

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
          <div className="h-full bg-chart-1" style={{ width: `${(cached / whole) * 100}%` }} />
          <div className="h-full bg-chart-3" style={{ width: `${(1 - cached / whole) * 100}%` }} />
        </div>
      )}
      <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          Prompt cache
          <InfoTip note={cacheNote} testId={`${prefix}-cache-note`} />
        </span>
        {status !== 'not-reported' ? (
          <span
            className="font-mono tabular-nums text-foreground"
            data-testid={`${prefix}-cache-status`}
            data-cache-status={status}
            data-cache-percent={pct !== undefined ? pct.toFixed(2) : undefined}
          >
            {pct !== undefined ? `${formatPercent(pct)} cached` : 'cached'}
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
}: {
  usage: TokenUsage
  speed?: UsageSpeed
  speedValue?: number
  prefix: string
}) {
  const kinds = usageValueKinds(usage)
  const estimated = speed?.source === 'estimated'
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
        {usage.totalTokens !== undefined && (
          <Tile
            testId={`${prefix}-total`}
            label="Total"
            value={exact(usage.totalTokens)}
            note={kinds.total === 'derived' ? 'Input plus output.' : undefined}
            data={{ 'data-value': usage.totalTokens }}
          />
        )}
      </div>
      <CacheLine usage={usage} prefix={prefix} />
      {speedValue !== undefined && (
        <Line
          testId={`${prefix}-speed`}
          label="Speed"
          value={`${estimated ? '~' : ''}${speedValue >= 100 ? Math.round(speedValue) : speedValue.toFixed(1)} tok/s`}
          note={speed?.source ? SPEED_NOTE[speed.source] : undefined}
          data={{ 'data-value': speedValue, 'data-source': speed?.source }}
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
}: {
  usage: TokenUsage
  session?: TokenUsage
  speed?: UsageSpeed
  scope?: string
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
        <Group usage={usage} speed={speed} speedValue={speed?.last} prefix="token-usage" />
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
              {` · ${requests} ${requests === 1 ? 'request' : 'requests'}`}
            </span>
          </div>
          <Group
            usage={session}
            speed={speed}
            speedValue={speed?.average}
            prefix="session-token-usage"
          />
        </section>
      )}
    </div>
  )
}
