import { useTranslation } from '@/i18n/react-i18next-compat'
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
  const { t } = useTranslation()
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
      aria-label={t('common:a11y.requestTokenUsage')}
      data-testid={id('breakdown')}
      data-usage-scope={scope}
    >
      {input !== undefined && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{t('common:usage.promptCache')}</span>
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
          {t('common:usage.requests', { count: usage.requests })}
          {usage.cacheHitRequests !== undefined &&
            t('common:usage.reusedOn', { count: usage.cacheHitRequests })}
          {usage.cacheReportedRequests !== undefined &&
            usage.cacheReportedRequests < usage.requests &&
            t('common:usage.didNotReport', { count: usage.requests - usage.cacheReportedRequests })}
        </div>
      )}
      {input !== undefined && (
        <Row
          testId={id('input')}
          icon={<ArrowUp className="size-3.5" aria-hidden />}
          label={t('common:usage.input')}
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
            label={t('common:usage.cachedInput')}
            value={cached}
            kind={kinds.cached}
            title={t('common:a11y.promptCacheRead')}
            indent
          />
          {uncached !== undefined && (
            <Row
              testId={id('uncached')}
              swatch="bg-chart-3"
              label={t('common:usage.uncachedInput')}
              value={uncached}
              kind={kinds.uncached}
              note={t('common:usage.uncachedNote')}
              indent
            />
          )}
        </>
      ) : (
        input !== undefined && (
          <Row
            testId={id('cache-unreported')}
            label={t('common:usage.cachedInput')}
            text={t('common:usage.notReported')}
            title={t('common:usage.unreportedNote')}
            muted
            indent
          />
        )
      )}

      {cacheWrite !== undefined && (
        <Row
          testId={id('cache-write')}
          swatch="bg-chart-2"
          label={t('common:usage.cacheWrite')}
          value={cacheWrite}
          kind={kinds.cacheWrite}
          note={t('common:usage.writeNote')}
          indent={cacheKnown ? 2 : 1}
        />
      )}

      {usage.outputTokens !== undefined && (
        <Row
          testId={id('output')}
          icon={<ArrowDown className="size-3.5" aria-hidden />}
          label={t('common:usage.output')}
          value={usage.outputTokens}
          kind={kinds.output}
        />
      )}

      {usage.totalTokens !== undefined && (
        <Row
          testId={id('total')}
          icon={<Sigma className="size-3.5" aria-hidden />}
          label={t('common:usage.total')}
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
          {t('common:usage.clamped', {
            detail:
              (usage.reported.cachedInputTokens !== undefined
                ? t('common:usage.clampedCached', { n: formatExact(usage.reported.cachedInputTokens) })
                : '') +
              (usage.reported.cacheWriteTokens !== undefined
                ? t('common:usage.clampedWrite', { n: formatExact(usage.reported.cacheWriteTokens) })
                : ''),
          })}
        </div>
      )}

      {source && (
        <div
          className="text-[10px] leading-snug text-muted-foreground break-words"
          data-testid={id('source')}
        >
          {t('common:usage.reportedVia', { source })}
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
  const { t } = useTranslation()
  const kindLabel: Record<UsageValueKind, string> = {
    reported: t('common:usage.kind.reported'),
    derived: t('common:usage.kind.derived'),
    clamped: t('common:usage.kind.clamped'),
  }
  const depth = indent === true ? 1 : indent || 0
  const shown = value !== undefined ? formatExact(value) : text
  return (
    <div
      className="flex items-center justify-between gap-3 text-xs"
      data-testid={testId}
      data-value={value}
      data-kind={kind}
      title={title}
      aria-label={
        kind
          ? t('common:usage.rowLabelKind', { label, value: shown, kind: kindLabel[kind] })
          : t('common:usage.rowLabel', { label, value: shown })
      }
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
            {kindLabel[kind]}
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
