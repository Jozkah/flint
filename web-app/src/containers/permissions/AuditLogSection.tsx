import type { Dispatch, SetStateAction } from 'react'
import { isServedByFlint } from '@/lib/platform/utils'
import { DecisionScope } from '@/containers/DecisionScope'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { type PermissionAuditRecord } from '@/lib/permissionAudit'
import { StatusChip, type StatusTone } from '@/containers/StatusChip'
import { EMPTY } from '@/containers/permissions/shared'
import { HISTORY_LIMIT, HISTORY_PREVIEW } from '@/hooks/useAuditHistory'

/** The tone a recorded decision is drawn in; the word itself is shown as is. */
function decisionTone(decision: string): StatusTone {
  const value = decision.toLowerCase()
  if (value.startsWith('allow') || value === 'approved') return 'success'
  if (value.startsWith('deny') || value.startsWith('refuse')) {
    return 'destructive'
  }
  return 'neutral'
}

/**
 * When a decision was made, in the app's language: today's read as a time of
 * day on one line; older ones add the date on a line above, so the column
 * stays narrow however long a locale writes a date. `full` is the hover text.
 */
function formatWhen(at: string, language?: string): {
  date: string | null
  time: string
  full: string
} {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return { date: null, time: at, full: at }
  const time = new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
  const full = new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
  if (date.toDateString() === new Date().toDateString())
    return { date: null, time, full }
  return {
    date: new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
    }).format(date),
    time,
    full,
  }
}

/** A decision's time, in the app's language: the date above the time when it is not today. */
function WhenCell({ at }: { at: string }) {
  const { i18n } = useTranslation()
  const when = formatWhen(at, i18n?.language)
  return (
    <time
      dateTime={at}
      title={when.full}
      className="flex flex-col font-mono text-xs leading-tight text-foreground"
    >
      {when.date && <span className="text-muted-foreground">{when.date}</span>}
      <span>{when.time}</span>
    </time>
  )
}

/** The word a recorded decision is shown as. */
function decisionKey(decision: string): string | null {
  const value = decision.toLowerCase()
  if (value.startsWith('allow') || value === 'approved' || value === 'granted')
    return 'permissions:settings.decisionAllowed'
  if (value.startsWith('deny') || value.startsWith('refuse'))
    return 'permissions:settings.decisionDenied'
  return null
}

export function AuditLogSection({
  history,
  historyError,
  historyExpanded,
  setHistoryExpanded,
}: {
  history: PermissionAuditRecord[] | null
  historyError: string | null
  historyExpanded: boolean
  setHistoryExpanded: Dispatch<SetStateAction<boolean>>
}) {
  const { t } = useTranslation()
  return (
    <Card
      anchor="settings-permissions-history"
      title={t('permissions:settings.history')}
      description={t('permissions:settings.historyDesc')}
      aside={t('permissions:settings.historyLimit', {
        count: HISTORY_LIMIT,
      })}
    >
      {isServedByFlint() ? (
        <p className={EMPTY} data-testid="history-desktop-only">
          {t('permissions:desktopOnly')}
        </p>
      ) : historyError ? (
        <p className={EMPTY}>
          {t('permissions:settings.historyUnavailable', {
            error: historyError,
          })}
        </p>
      ) : history && history.length === 0 ? (
        <p className={EMPTY}>{t('permissions:settings.historyEmpty')}</p>
      ) : history === null ? (
        <p className={EMPTY} aria-busy>
          {t('permissions:settings.loading')}
        </p>
      ) : (
        // A real table at every width; on a narrow screen it scrolls
        // sideways inside this container, never the page.
        <div
          className="min-w-0 overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label={t('permissions:settings.history')}
        >
          <table className="w-full min-w-[26rem] border-collapse text-left text-[length:calc(var(--ui-font-base)*0.78125)] tabular-nums">
            <thead>
              <tr className="border-b border-dashed border-border text-xs text-muted-foreground">
                <th scope="col" className="px-0.5 py-2 pr-3 font-normal">
                  {t('permissions:settings.historyTime')}
                </th>
                <th scope="col" className="w-24 px-0.5 py-2 font-normal">
                  {t('permissions:settings.historyTool')}
                </th>
                <th scope="col" className="px-0.5 py-2 font-normal">
                  {t('permissions:settings.historyScope')}
                </th>
                <th scope="col" className="w-24 px-0.5 py-2 font-normal">
                  {t('permissions:settings.historyDecision')}
                </th>
              </tr>
            </thead>
            <tbody>
              {(historyExpanded
                ? history
                : history.slice(0, HISTORY_PREVIEW)
              ).map((record, index) => (
                <tr
                  key={`${record.at}-${record.call}-${index}`}
                  className="border-b border-dashed border-border last:border-b-0"
                >
                  <td className="px-0.5 py-2 pr-3 align-middle whitespace-nowrap">
                    <WhenCell at={record.at} />
                  </td>
                  <td className="max-w-24 px-0.5 py-2 align-middle">
                    <span
                      className="block truncate font-mono text-xs text-foreground"
                      title={record.tool}
                    >
                      {record.tool}
                    </span>
                  </td>
                  <td className="w-full max-w-0 min-w-0 px-0.5 py-2 align-middle">
                    <DecisionScope
                      resource={record.resource}
                      reason={record.reason}
                    />
                  </td>
                  <td className="px-0.5 py-2 align-middle">
                    <StatusChip tone={decisionTone(record.decision)}>
                      {decisionKey(record.decision)
                        ? t(decisionKey(record.decision)!)
                        : record.decision}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > HISTORY_PREVIEW && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="permissions-history-toggle"
              className="mt-1"
              onClick={() => setHistoryExpanded((v) => !v)}
            >
              {historyExpanded
                ? t('permissions:settings.historyShowFewer')
                : t('permissions:settings.historyShowAll', {
                    count: history.length,
                  })}
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
