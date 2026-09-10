import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  IconArrowUp,
  IconArrowDown,
  IconSum,
  IconInfoCircle,
} from '@tabler/icons-react'
import type { TokenUsage } from '@/lib/tokenUsage'

/** Why "Uncached input" is not a count of cache misses. */
export const UNCACHED_INPUT_NOTE =
  'Derived: input tokens minus cached input tokens. This is a token count, not a number of cache-miss events.'

export const CACHE_UNREPORTED_NOTE =
  'The provider did not report prompt-cache usage for this request, so no cached or uncached split is shown.'

export const CACHE_WRITE_NOTE =
  'Tokens the provider wrote to its prompt cache. They are part of the uncached input and are not counted again in the total.'

const formatExact = (num: number) => num.toLocaleString()

/**
 * The detailed token breakdown shown in the counter's popover, for Chat and
 * Cowork alike.
 *
 * A row is drawn only for a count the provider reported. When the cache was
 * not reported, a single "Not reported" row says so rather than showing a
 * cached figure of zero that nobody measured.
 */
export function TokenUsageBreakdown({
  usage,
  className,
}: {
  usage: TokenUsage
  className?: string
}) {
  const input = usage.inputTokens
  const cached = usage.cachedInputTokens
  const uncached = usage.uncachedInputTokens
  const cacheWrite = usage.cacheWriteTokens
  const cacheKnown = cached !== undefined

  return (
    <div
      className={cn('space-y-1.5', className)}
      data-testid="token-usage-breakdown"
    >
      {input !== undefined && (
        <Row
          testId="token-usage-input"
          icon={<IconArrowUp className="size-3.5" />}
          label="Input"
          value={input}
        />
      )}

      {cacheKnown && input !== undefined && input > 0 && (
        <CacheBar cached={cached} uncached={uncached ?? 0} />
      )}

      {cacheKnown ? (
        <>
          <Row
            testId="token-usage-cached"
            swatch="bg-emerald-500"
            label="Cached input"
            value={cached}
            title="Read from the provider's prompt cache"
            indent
          />
          {uncached !== undefined && (
            <Row
              testId="token-usage-uncached"
              swatch="bg-sky-500"
              label="Uncached input"
              value={uncached}
              note={UNCACHED_INPUT_NOTE}
              indent
            />
          )}
        </>
      ) : (
        input !== undefined && (
          <Row
            testId="token-usage-cache-unreported"
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
          testId="token-usage-cache-write"
          swatch="bg-violet-500"
          label="Cache write"
          value={cacheWrite}
          note={CACHE_WRITE_NOTE}
          indent={cacheKnown ? 2 : 1}
        />
      )}

      {usage.outputTokens !== undefined && (
        <Row
          testId="token-usage-output"
          icon={<IconArrowDown className="size-3.5" />}
          label="Output"
          value={usage.outputTokens}
        />
      )}

      {usage.totalTokens !== undefined && (
        <Row
          testId="token-usage-total"
          icon={<IconSum className="size-3.5" />}
          label="Total"
          value={usage.totalTokens}
          strong
        />
      )}

      {usage.reported && (
        <div
          className="text-[11px] leading-snug text-amber-600"
          data-testid="token-usage-clamped"
        >
          The provider reported inconsistent cache counts
          {usage.reported.cachedInputTokens !== undefined &&
            ` (cached ${formatExact(usage.reported.cachedInputTokens)})`}
          {usage.reported.cacheWriteTokens !== undefined &&
            ` (cache write ${formatExact(usage.reported.cacheWriteTokens)})`}
          ; the values above were clamped to the input.
        </div>
      )}
    </div>
  )
}

/** Cached against freshly processed input, as one bar. */
function CacheBar({ cached, uncached }: { cached: number; uncached: number }) {
  const whole = cached + uncached
  if (whole <= 0) return null
  const cachedPct = (cached / whole) * 100
  return (
    <div
      className="ml-5 flex h-1.5 overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
      data-testid="token-usage-cache-bar"
    >
      <div className="h-full bg-emerald-500" style={{ width: `${cachedPct}%` }} />
      <div
        className="h-full bg-sky-500"
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
  strong?: boolean
  muted?: boolean
  indent?: boolean | 1 | 2
}) {
  const depth = indent === true ? 1 : indent || 0
  return (
    <div
      className="flex items-center justify-between text-xs"
      data-testid={testId}
      data-value={value}
      title={title}
    >
      <span
        className={cn(
          'flex items-center gap-1.5 text-muted-foreground',
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
        {label}
        {note && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex text-muted-foreground/70 hover:text-foreground"
                aria-label={note}
                data-testid={`${testId}-note`}
              >
                <IconInfoCircle className="size-3" />
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
      <span
        className={cn(
          'font-mono tabular-nums',
          muted ? 'text-muted-foreground italic' : 'text-foreground',
          strong && 'font-semibold'
        )}
      >
        {value !== undefined ? formatExact(value) : text}
      </span>
    </div>
  )
}
