// Presentational pieces of the token counter, split out of TokenCounter.tsx.

import { useCallback, useId, useRef, useState } from 'react'
import { POPUP_COLLISION_PADDING } from '@/components/ui/popup-edge'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, formatTokenCount } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { type TokenUsage } from '@/lib/tokenUsage'
import { TokenUsageSummary, type UsageSpeed } from '@/components/TokenUsageSummary'
import { type Pricing } from '@/lib/modelPricing'
import { type ContextUsage } from '@/lib/contextUsage'
import { Brain } from 'lucide-react'

/**
 * Hover previews the card; a click pins it open and a second click, Escape or
 * a click outside closes it. Radix opens a tooltip only on hover or focus and
 * closes it on the trigger's own press, so on its own a click could not
 * reopen the card until the pointer left and came back.
 */
export function usePinnedCard() {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const onOpenChange = useCallback((next: boolean) => {
    // A pinned card ignores the pointer leaving, blur and the press itself.
    if (!next && pinned.current) return
    setOpen(next)
  }, [])
  const dismiss = useCallback(() => {
    pinned.current = false
    setOpen(false)
  }, [])
  const toggle = useCallback(() => {
    if (pinned.current) {
      dismiss()
    } else {
      pinned.current = true
      setOpen(true)
    }
  }, [dismiss])
  const contentProps = {
    onEscapeKeyDown: dismiss,
    onPointerDownOutside: (e: Event) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      dismiss()
    },
  }
  return { open, onOpenChange, toggle, triggerRef, contentProps }
}

export function TokenCountOnly({
  totalTokens,
  usage,
  sessionUsage,
  scope,
  modelDisplayName,
  speed,
  pricing,
  onSetPrice,
  card,
  ringUsage,
  className,
}: {
  totalTokens: number
  usage: TokenUsage
  sessionUsage?: TokenUsage
  scope?: string
  modelDisplayName?: string
  speed?: UsageSpeed
  pricing?: Pricing | null
  onSetPrice?: () => void
  card?: React.ReactNode
  ringUsage: ContextUsage
  className?: string
}) {
  const { t } = useTranslation()
  const pinned = usePinnedCard()
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip open={pinned.open} onOpenChange={pinned.onOpenChange}>
        <TooltipTrigger asChild>
          <button
            ref={pinned.triggerRef}
            type="button"
            aria-label={t('common:a11y.tokenUsage')}
            aria-expanded={pinned.open}
            data-testid="token-counter"
            data-usage-scope={scope}
            className={cn('hit-y cursor-pointer', className)}
            onClick={pinned.toggle}
          >
            {/* No window size is known for this provider, so the ring has no
                fill to show: the same ring the local models get, dashed. */}
            <div className="grid size-7 place-items-center rounded-full transition-colors hover:bg-accent">
              <ContextRing usage={ringUsage} />
              <span className="sr-only">{t('common:usage.counter.tokenUsageSr', { value: formatTokenCount(totalTokens) })}</span>
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="center"
          sideOffset={6}
          collisionPadding={POPUP_COLLISION_PADDING}
          showArrow={false}
          className="w-[340px] max-w-[calc(100vw-2rem)] max-h-(--radix-tooltip-content-available-height) overflow-y-auto overscroll-contain rounded-xl bg-popover p-0 text-left text-xs font-normal leading-normal text-popover-foreground shadow-pop"
          data-testid="token-usage-popover"
          {...pinned.contentProps}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Brain className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">
                {t('common:usage.counter.tokenUsage')}
              </div>
              {modelDisplayName && (
                <div className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground truncate">
                  {modelDisplayName}
                </div>
              )}
            </div>
          </div>
          {card ? <div className="border-b border-border">{card}</div> : null}
          <TokenUsageSummary
            usage={usage}
            session={sessionUsage}
            speed={speed}
            scope={scope}
            pricing={pricing}
            onSetPrice={onSetPrice}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** The composer's ring: a dashed empty one when the window is not known. */
export function ContextRing({
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
          className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-(--duration-very-slow) motion-safe:ease-expo"
        />
      )}
    </svg>
  )
}
