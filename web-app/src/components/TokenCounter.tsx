import { useMemo, useEffect, useState, useRef, useId, memo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, formatTokenCount } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTokensCount, type TokenUsageSource } from '@/hooks/useTokensCount'
import { ThreadMessage } from '@janhq/core'
import {
  finalizeTokenUsage,
  readTokenUsage,
  summarizeUsage,
  type TokenUsage,
} from '@/lib/tokenUsage'
import { TokenUsageBreakdown } from '@/components/TokenUsageBreakdown'
import { speedStats, type SpeedSample } from '@/lib/tokenSpeed'
import { ContextWindowCard } from '@/components/ContextWindowCard'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
import { reconcileBreakdown } from '@/lib/contextBreakdown'
import { contextUsage, type ContextUsage } from '@/lib/contextUsage'
import {
  DEFAULT_COMPACTION_POLICY,
  effectiveReserve,
  getCompactionPolicy,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import {
  Brain,
  Gauge,
  Ruler,
  Layers2,
  Image,
  Mic,
  Moon,
  Sliders,
} from 'lucide-react'

interface TokenCounterProps {
  messages?: ThreadMessage[]
  className?: string
  compact?: boolean
  additionalTokens?: number
  /** Usage reported directly, for a surface that keeps no thread messages. */
  source?: TokenUsageSource
  /** Generation speed of the latest reply and the conversation's average. */
  speed?: { last?: number; average?: number }
  /** Compacts the conversation; offered from the context card when given. */
  onCompact?: () => void
}

const formatExact = (num: number) => num.toLocaleString()

export const TokenCounter = memo(function TokenCounter({
  messages = [],
  className,
  additionalTokens = 0,
  source,
  speed: speedProp,
  onCompact,
}: TokenCounterProps) {
  const { t } = useTranslation()
  const { calculateTokens, ...tokenData } = useTokensCount(messages, source)
  // Which conversation these numbers belong to, stamped on the badge and its
  // popover so nothing -- a test, a screen reader, a stale portal left over
  // from the previous session -- can mistake one session's usage for another's.
  const scope = source?.threadId ?? messages[0]?.thread_id
  // Every request of this conversation, added up: a surface that keeps its
  // own turns hands them in; a chat thread's messages each carry theirs.
  const sessionUsage = useMemo(
    () =>
      source?.session ??
      summarizeUsage(
        messages.map((m) =>
          readTokenUsage((m.metadata as { usage?: unknown } | undefined)?.usage)
        )
      ),
    [source?.session, messages]
  )

  // How fast the replies came: handed in, else reported by the surface, else
  // read from the messages' own timing.
  const speed = useMemo(
    () =>
      speedProp ??
      source?.speed ??
      speedStats(
        messages.map((m) => {
          const meta = m.metadata as
            | { tokenSpeed?: SpeedSample; usage?: unknown }
            | undefined
          const ts = meta?.tokenSpeed
          if (!ts) return undefined
          return {
            tokenSpeed: ts.tokenSpeed,
            durationMs: ts.durationMs,
            tokenCount: readTokenUsage(meta?.usage)?.outputTokens ?? ts.tokenCount,
          }
        })
      ),
    [speedProp, source?.speed, messages]
  )

  // What the last request carried, by kind, for the context card.
  const stored = useContextBreakdown((s) => (scope ? s.byId[scope] : undefined))
  const [policy, setPolicy] = useState<CompactionPolicy>(DEFAULT_COMPACTION_POLICY)
  useEffect(() => {
    let alive = true
    getCompactionPolicy()
      .then((p) => alive && setPolicy(p))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const [isAnimating, setIsAnimating] = useState(false)
  const [prevTokenCount, setPrevTokenCount] = useState(0)
  const [isUpdating, setIsUpdating] = useState(false)
  const timersRef = useRef<{ update?: NodeJS.Timeout; anim?: NodeJS.Timeout }>(
    {}
  )

  const handleCalculateTokens = () => {
    calculateTokens()
  }

  useEffect(() => {
    const currentTotal = tokenData.tokenCount + additionalTokens
    const timers = timersRef.current
    if (timers.update) clearTimeout(timers.update)
    if (timers.anim) clearTimeout(timers.anim)

    if (currentTotal !== prevTokenCount) {
      setIsUpdating(true)
      timers.update = setTimeout(() => setIsUpdating(false), 250)
      if (prevTokenCount > 0 && Math.abs(currentTotal - prevTokenCount) > 10) {
        setIsAnimating(true)
        timers.anim = setTimeout(() => setIsAnimating(false), 600)
      }
      setPrevTokenCount(currentTotal)
    }

    return () => {
      if (timers.update) clearTimeout(timers.update)
      if (timers.anim) clearTimeout(timers.anim)
    }
  }, [tokenData.tokenCount, additionalTokens, prevTokenCount])

  const totalTokens = useMemo(
    () => tokenData.tokenCount + additionalTokens,
    [tokenData.tokenCount, additionalTokens]
  )

  const reconciled = useMemo(
    () => (stored ? reconcileBreakdown(stored, totalTokens) : null),
    [stored, totalTokens]
  )

  // The ring and the card both read this one figure, so they cannot differ.
  const usage = contextUsage(
    reconciled?.usedTokens ?? totalTokens,
    tokenData.maxTokens,
    policy.auto ? effectiveReserve(tokenData.maxTokens ?? 0, policy) : 0
  )

  // What the popover itemises. A caller that reported no breakdown still has
  // its input/output/total, which is all the older counter showed.
  const breakdown: TokenUsage = useMemo(
    () =>
      tokenData.usage ??
      finalizeTokenUsage({
        inputTokens: tokenData.inputTokens,
        outputTokens: tokenData.outputTokens,
        totalTokens: tokenData.tokenCount > 0 ? tokenData.tokenCount : undefined,
      }),
    [
      tokenData.usage,
      tokenData.inputTokens,
      tokenData.outputTokens,
      tokenData.tokenCount,
    ]
  )

  const tier = usage.tier

  // Remote providers report no context-window denominator, so a percentage is
  // meaningless. Show a plain total-tokens badge once a turn has counted tokens.
  if (!tokenData.maxTokens) {
    if (totalTokens <= 0) return null
    return (
      <TokenCountOnly
        totalTokens={totalTokens}
        usage={breakdown}
        sessionUsage={sessionUsage}
        scope={scope}
        modelDisplayName={tokenData.modelDisplayName}
        speed={speed}
        ringUsage={usage}
        card={
          reconciled ? (
            <ContextWindowCard
              segments={reconciled.segments}
              usedTokens={reconciled.usedTokens}
              updatedAt={stored?.at}
              onCompact={onCompact}
            />
          ) : null
        }
        className={className}
      />
    )
  }

  const textCls =
    tier === 'over'
      ? 'text-destructive'
      : tier === 'warn'
        ? 'text-warning'
        : 'text-foreground'
  // Theme tokens, so the ring follows light and dark mode.
  const ringColors =
    tier === 'over'
      ? ['var(--warning)', 'var(--destructive)']
      : tier === 'warn'
        ? ['var(--warning)', 'var(--warning)']
        : ['var(--success)', 'var(--success)']
  const barCls =
    tier === 'over'
      ? 'bg-destructive'
      : tier === 'warn'
        ? 'bg-amber-500'
        : 'bg-primary'

  const { modelProps, modelDisplayName } = tokenData
  const remaining = Math.max(0, tokenData.maxTokens - totalTokens)
  const showFittedBadge =
    tokenData.fitEnabled &&
    typeof tokenData.configuredCtxLen === 'number' &&
    tokenData.configuredCtxLen !== tokenData.maxTokens
  const hasModalities =
    tokenData.modalities?.vision || tokenData.modalities?.audio
  const showFooter =
    showFittedBadge ||
    hasModalities ||
    modelProps?.isSleeping ||
    (modelProps?.totalSlots !== undefined && modelProps.totalSlots > 1)

  return (
    <TooltipProvider delayDuration={isUpdating ? 1200 : 400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Token usage"
            data-testid="token-counter"
            data-usage-scope={scope}
            className={cn('relative cursor-pointer', className)}
            onClick={handleCalculateTokens}
          >
            {/* The composer's context ring: how full the window is, as a
                circle and nothing else. The figures are on hover; a
                screen reader gets the same in words. */}
            <div
              className={cn(
                'grid size-7 place-items-center rounded-full transition-colors hover:bg-accent',
                isAnimating && 'scale-110'
              )}
            >
              <ContextRing usage={usage} colors={ringColors} />
              <span className="sr-only" data-testid="context-percent">
                {`Context ${usage.pct.toFixed(0)}% full`}
              </span>
              {tier !== 'ok' && (
                // AH-077: said in words, not only by colour, and announced.
                <span
                  role="status"
                  data-testid="context-pressure"
                  data-tier={tier}
                  className="sr-only"
                >
                  {tier === 'over' ? 'Full' : 'Nearly full'}
                </span>
              )}
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="center"
          sideOffset={6}
          showArrow={false}
          className="min-w-72 max-w-80 bg-background border p-0 overflow-hidden"
          data-testid="token-usage-popover"
        >
          {reconciled ? (
            <div className="border-b border-border">
              {tier !== 'ok' && (
                <p
                  data-testid="context-pressure-detail"
                  className={cn('px-3 pt-2.5 text-[11px] leading-snug', textCls)}
                >
                  {tier === 'over'
                    ? 'This conversation is larger than the context window: the next request may be cut or refused. Start a new chat or remove attachments.'
                    : `${formatExact(remaining)} tokens left. Start a new chat or remove attachments before the window fills.`}
                </p>
              )}
              <ContextWindowCard
                segments={reconciled.segments}
                usedTokens={reconciled.usedTokens}
                windowTokens={tokenData.maxTokens}
                updatedAt={stored?.at}
                autoCompactOn={policy.auto}
                autoCompactBuffer={effectiveReserve(tokenData.maxTokens, policy)}
                onCompact={onCompact}
              />
            </div>
          ) : (
            <>
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
            <Brain className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">
                Context window
              </div>
              {modelDisplayName && (
                <div className="text-[11px] text-muted-foreground truncate">
                  {modelDisplayName}
                </div>
              )}
            </div>
            {modelProps?.isSleeping && (
              <Moon
                className="size-3.5 text-muted-foreground"
                aria-label="Model sleeping"
              />
            )}
          </div>

          {/* Progress block */}
          <div className="px-3 py-2.5">
            {tier !== 'ok' && (
              <p
                data-testid="context-pressure-detail"
                className={cn('mb-2 text-[11px] leading-snug', textCls)}
              >
                {tier === 'over'
                  ? 'This conversation is larger than the context window: the next request may be cut or refused. Start a new chat or remove attachments.'
                  : `${formatExact(remaining)} tokens left. Start a new chat or remove attachments before the window fills.`}
                {/* AH-077: an estimate that reads like a measurement is worse
                    than no number, so the figures say where they came from. */}
                <span className="block" data-testid="context-pressure-source">
                  {formatExact(totalTokens)} of {formatExact(tokenData.maxTokens)} tokens,{' '}
                  {breakdown.reported
                    ? 'counted by the provider'
                    : "Flint's estimate"}
                </span>
              </p>
            )}
            <div className="flex items-baseline justify-between mb-1.5">
              <span
                className={cn(
                  'text-xl font-semibold tabular-nums leading-none',
                  textCls
                )}
              >
                {usage.pct.toFixed(1)}%
              </span>
              <span className="text-xs text-muted-foreground tabular-nums font-mono">
                {formatTokenCount(totalTokens)} /{' '}
                {formatTokenCount(tokenData.maxTokens)}
              </span>
            </div>
            <div className="w-full h-1.5 bg-track rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500 ease-out',
                  barCls
                )}
                style={{ width: `${usage.pct}%` }}
              />
            </div>
            {tokenData.isOverflow && (
              <div className="mt-1.5 text-[11px] text-destructive leading-snug">
                {t('model-errors:lastRequestOverflowed')}
              </div>
            )}
          </div>

            </>
          )}

          <SpeedSection speed={speed} />

          {/* Token breakdown */}
          <div className="px-3 py-2 border-t border-border space-y-1.5">
            <TokenUsageBreakdown usage={breakdown} scope={scope} />
            <Row
              icon={<Ruler className="size-3.5" />}
              label="Remaining"
              value={formatExact(remaining)}
            />
          </div>

          <SessionUsageSection usage={sessionUsage} scope={scope} />

          {/* Footer: fit + slots + modalities */}
          {showFooter && (
            <div className="px-3 py-2 border-t border-border flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {showFittedBadge && (
                <span
                  className="flex items-center gap-1"
                  title={`Configured ctx_len: ${formatExact(tokenData.configuredCtxLen!)}`}
                >
                  <Sliders className="size-3" />
                  Fitted to {formatTokenCount(tokenData.maxTokens)}
                </span>
              )}
              {modelProps?.totalSlots !== undefined &&
                modelProps.totalSlots > 1 && (
                  <span className="flex items-center gap-1">
                    <Layers2 className="size-3" />
                    {modelProps.totalSlots} slots
                  </span>
                )}
              {tokenData.modalities?.vision && (
                <span
                  className="flex items-center gap-1"
                  title="Vision input supported"
                >
                  <Image className="size-3" />
                  Vision
                </span>
              )}
              {tokenData.modalities?.audio && (
                <span
                  className="flex items-center gap-1"
                  title="Audio input supported"
                >
                  <Mic className="size-3" />
                  Audio
                </span>
              )}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

function TokenCountOnly({
  totalTokens,
  usage,
  sessionUsage,
  scope,
  modelDisplayName,
  speed,
  card,
  ringUsage,
  className,
}: {
  totalTokens: number
  usage: TokenUsage
  sessionUsage?: TokenUsage
  scope?: string
  modelDisplayName?: string
  speed?: { last?: number; average?: number }
  card?: React.ReactNode
  ringUsage: ContextUsage
  className?: string
}) {
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Token usage"
            data-testid="token-counter"
            data-usage-scope={scope}
            className={cn('relative cursor-default', className)}
          >
            {/* No window size is known for this provider, so the ring has no
                fill to show: the same ring the local models get, dashed. */}
            <div className="grid size-7 place-items-center rounded-full transition-colors hover:bg-accent">
              <ContextRing usage={ringUsage} />
              <span className="sr-only">{`Token usage ${formatTokenCount(totalTokens)}`}</span>
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="center"
          sideOffset={6}
          showArrow={false}
          className="min-w-64 max-w-80 bg-background border p-0 overflow-hidden"
          data-testid="token-usage-popover"
        >
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
            <Brain className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">
                Token usage
              </div>
              {modelDisplayName && (
                <div className="text-[11px] text-muted-foreground truncate">
                  {modelDisplayName}
                </div>
              )}
            </div>
          </div>
          {card ? <div className="border-b border-border">{card}</div> : null}
          <div className="px-3 py-2">
            <TokenUsageBreakdown usage={usage} scope={scope} />
          </div>
          <SpeedSection speed={speed} />
          <SessionUsageSection usage={sessionUsage} scope={scope} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** The composer's ring: a dashed empty one when the window is not known. */
function ContextRing({
  usage,
  colors = ['var(--success)', 'var(--success)'],
}: {
  usage: ContextUsage
  colors?: string[]
}) {
  const gradientId = useId()
  const c = 2 * Math.PI * 8
  return (
    <svg
      aria-hidden
      className="size-[18px] shrink-0 -rotate-90"
      viewBox="0 0 20 20"
      data-testid="context-ring"
      data-window={usage.known ? 'known' : 'unknown'}
      data-fraction={usage.fraction.toFixed(4)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: colors[0] }} />
          <stop offset="1" style={{ stopColor: colors[1] }} />
        </linearGradient>
      </defs>
      <circle
        cx="10"
        cy="10"
        r="8"
        strokeWidth="2.4"
        fill="none"
        className={usage.known ? 'stroke-track' : 'stroke-muted-foreground/50'}
        strokeDasharray={usage.known ? undefined : '2.5 2.5'}
      />
      {usage.known && (
        <circle
          cx="10"
          cy="10"
          r="8"
          strokeWidth="2.4"
          fill="none"
          strokeLinecap="round"
          stroke={`url(#${gradientId})`}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - usage.fraction)}
          className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-expo"
        />
      )}
    </svg>
  )
}

/** Generation speed, when at least one reply was long enough to time. */
function SpeedSection({ speed }: { speed?: { last?: number; average?: number } }) {
  if (!speed?.last && !speed?.average) return null
  const fmt = (n: number) => `${n >= 100 ? Math.round(n) : n.toFixed(1)} tokens/sec`
  return (
    <div className="px-3 py-2 border-t border-border space-y-1" data-testid="speed-section">
      <div className="text-[11px] font-medium text-foreground">Generation speed</div>
      {speed.last ? (
        <Row icon={<Gauge className="size-3.5" />} label="Latest reply" value={fmt(speed.last)} />
      ) : null}
      {speed.average ? (
        <Row icon={<Gauge className="size-3.5" />} label="Average" value={fmt(speed.average)} />
      ) : null}
    </div>
  )
}

function Row({
  icon,
  label,
  value,
  strong,
}: {
  icon: React.ReactNode
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          'font-mono tabular-nums',
          strong ? 'text-foreground font-semibold' : 'text-foreground'
        )}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * Every request of this conversation, added up: how many requests there were
 * and how many reused the provider's cache, apart from the token totals.
 */
function SessionUsageSection({
  usage,
  scope,
}: {
  usage?: TokenUsage
  scope?: string
}) {
  if (!usage || (usage.requests ?? 0) <= 0) return null
  return (
    <div
      className="px-3 py-2 border-t border-border space-y-1"
      data-testid="session-usage"
      data-usage-scope={scope}
      data-requests={usage.requests}
      data-cache-hit-requests={usage.cacheHitRequests}
    >
      <div className="text-[11px] font-medium text-foreground">
        This conversation ({usage.requests}{' '}
        {usage.requests === 1 ? 'request' : 'requests'})
      </div>
      <TokenUsageBreakdown usage={usage} scope={scope} testIdPrefix="session-token-usage" />
    </div>
  )
}
