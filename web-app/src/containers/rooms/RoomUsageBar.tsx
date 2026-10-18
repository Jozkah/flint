import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Room } from '@/lib/rooms/types'
import { isCompareRoom } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatCompact, formatDuration, formatNumber, formatUsd, stopReasonText } from './roomUi'

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 shrink-0 items-baseline gap-1 whitespace-nowrap">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground">{children}</dd>
    </div>
  )
}

export function RoomUsageBar({ room }: { room: Room }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { usage, limits } = room
  const of = (value: string, max: string) => t('rooms:usage.of', { value, max })
  const tokens = usage.inputTokens + usage.outputTokens
  // Narrow: one tappable line under the header, the full figures on demand.
  const [open, setOpen] = useState(false)
  const turns = of(formatNumber(usage.turns, lang), formatNumber(limits.maxTurns, lang))

  return (
    <section
      aria-label={t('rooms:usage.label')}
      data-testid="room-usage"
      data-open={open || undefined}
      className="shrink-0 border-b border-dashed border-border px-3 py-1.5 text-xs @[40rem]/room:px-4"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="room-usage-toggle"
        className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 text-left text-muted-foreground hover:text-foreground @[40rem]/room:hidden"
      >
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {t('rooms:usage.turns')} <span className="font-semibold text-foreground">{turns}</span>
          {' · '}
          {usage.costUsd === null ? t('rooms:usage.costUnavailable') : formatUsd(usage.costUsd, lang)}
          {' · '}
          {formatDuration(usage.activeMs)}
        </span>
        <ChevronDown aria-hidden className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      <dl
        data-testid="room-usage-details"
        className={cn(
          'flex-wrap gap-x-4 gap-y-1.5 py-1 @[40rem]/room:flex @[40rem]/room:py-0.5',
          open ? 'flex' : 'hidden'
        )}
      >
        <Stat label={t('rooms:usage.turns')}>{turns}</Stat>
        {/* A compare room spends one round per question: call it that. */}
        <Stat label={t(isCompareRoom(room) ? 'rooms:usage.questions' : 'rooms:usage.rounds')}>
          {of(formatNumber(usage.rounds, lang), formatNumber(limits.maxRounds, lang))}
        </Stat>
        <Stat label={t('rooms:usage.tokens')}>
          <span title={of(formatNumber(tokens, lang), formatNumber(limits.maxTotalTokens, lang))}>
            {of(formatCompact(tokens, lang), formatCompact(limits.maxTotalTokens, lang))}
          </span>
          {usage.estimated && (
            <span className="ml-1 font-normal text-muted-foreground">
              ({t('rooms:usage.estimated')})
            </span>
          )}
        </Stat>
        <Stat label={t('rooms:usage.cost')}>
          {usage.costUsd === null ? (
            <span className="font-normal text-muted-foreground">
              {t('rooms:usage.costUnavailable')}
            </span>
          ) : (
            of(
              formatUsd(usage.costUsd, lang),
              limits.maxCostUsd === null ? t('rooms:usage.noLimit') : formatUsd(limits.maxCostUsd, lang)
            )
          )}
        </Stat>
        <Stat label={t('rooms:usage.time')}>
          {of(formatDuration(usage.activeMs), formatDuration(limits.maxDurationMs))}
        </Stat>
        {/* On the stats row, not a line of its own: stopping must not push
            the transcript down. */}
        {room.stopReason && room.status !== 'running' && (
          <div className="ml-auto min-w-0 truncate text-muted-foreground">
            <dd data-testid="room-stop-reason" className="truncate">
              {t('rooms:usage.stopReason', { reason: stopReasonText(room.stopReason, t) })}
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}
