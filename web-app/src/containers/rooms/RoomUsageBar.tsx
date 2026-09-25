import type { Room } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatCompact, formatDuration, formatNumber, formatUsd, stopReasonText } from './roomUi'

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground">{children}</dd>
    </div>
  )
}

export function RoomUsageBar({ room }: { room: Room }) {
  const { t } = useTranslation()
  const { usage, limits } = room
  const of = (value: string, max: string) => t('rooms:usage.of', { value, max })
  const tokens = usage.inputTokens + usage.outputTokens

  return (
    <section
      aria-label={t('rooms:usage.label')}
      className="shrink-0 border-b border-dashed border-border px-4 py-[7px] text-xs"
    >
      <dl className="flex flex-wrap gap-x-[18px] gap-y-1.5">
        <Stat label={t('rooms:usage.turns')}>
          {of(formatNumber(usage.turns), formatNumber(limits.maxTurns))}
        </Stat>
        <Stat label={t('rooms:usage.rounds')}>
          {of(formatNumber(usage.rounds), formatNumber(limits.maxRounds))}
        </Stat>
        <Stat label={t('rooms:usage.tokens')}>
          <span title={of(formatNumber(tokens), formatNumber(limits.maxTotalTokens))}>
            {of(formatCompact(tokens), formatCompact(limits.maxTotalTokens))}
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
              formatUsd(usage.costUsd),
              limits.maxCostUsd === null ? t('rooms:usage.noLimit') : formatUsd(limits.maxCostUsd)
            )
          )}
        </Stat>
        <Stat label={t('rooms:usage.time')}>
          {of(formatDuration(usage.activeMs), formatDuration(limits.maxDurationMs))}
        </Stat>
      </dl>
      {room.stopReason && room.status !== 'running' && (
        <p className="mt-1.5 text-muted-foreground" data-testid="room-stop-reason">
          {t('rooms:usage.stopReason', { reason: stopReasonText(room.stopReason, t) })}
        </p>
      )}
    </section>
  )
}
