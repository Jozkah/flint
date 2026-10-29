import { useEffect, useState } from 'react'
import { invokeCommand } from '@/lib/backend'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import { isServedByFlint } from '@/lib/platform/utils'

export type AttributionBucket = {
  name: string
  calls: number
  resultTokens: number
  inputTokens?: number
  outputTokens?: number
}

export type UnusedItem = {
  kind: 'skill' | 'plugin' | 'mcp' | 'subagent'
  name: string
  contextTokens?: number
}

export type Attribution = {
  since: string | null
  skills: AttributionBucket[]
  mcpServers: AttributionBucket[]
  plugins: AttributionBucket[]
  subagents: AttributionBucket[]
  unused: UnusedItem[]
}

const WINDOW = '30d'

function Section({
  title,
  rows,
  callsLabel,
}: {
  title: string
  rows: AttributionBucket[]
  callsLabel: (n: number) => string
}) {
  const { t, i18n } = useTranslation()
  const num = (n: number) => n.toLocaleString(i18n?.language)
  if (rows.length === 0) return null
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {rows.map((r) => (
        <div key={r.name} className="flex justify-between gap-3 text-sm">
          <span className="truncate">{r.name}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {callsLabel(r.calls)} ·{' '}
            {t('settings:usageAttribution.approxTokens', {
              n: num(r.resultTokens),
            })}
            {r.inputTokens !== undefined && r.outputTokens !== undefined
              ? ` · ${t('settings:usageAttribution.inOut', {
                  in: num(r.inputTokens),
                  out: num(r.outputTokens),
                })}`
              : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Where calls and subagent tokens went over the last 30 days, by skill, MCP
 * server, plugin and subagent, and what is configured but never used. Read from
 * the per-session event logs; per-session subagent numbers stay in
 * coworkSubagentStats.
 */
export function UsageAttributionCard() {
  const { t } = useTranslation()
  const [data, setData] = useState<Attribution | null>(null)
  const served = isServedByFlint()

  useEffect(() => {
    if (served) return
    invokeCommand<Attribution>('get_usage_attribution', { since: WINDOW })
      .then(setData)
      .catch((e) => toast.error(errorText(e)))
  }, [served])

  if (served || !data) return null
  const calls = (n: number) => t('settings:usageAttribution.calls', { count: n })
  const empty =
    !data.skills.length &&
    !data.mcpServers.length &&
    !data.plugins.length &&
    !data.subagents.length
  return (
    <Card title={t('settings:usageAttribution.title')} description={t('settings:usageAttribution.description', { window: WINDOW })}>
      <div className="space-y-3" data-testid="usage-attribution">
        {empty && (
          <div className="text-sm text-muted-foreground">{t('settings:usageAttribution.empty')}</div>
        )}
        <Section title={t('settings:usageAttribution.subagents')} rows={data.subagents} callsLabel={calls} />
        <Section title={t('settings:usageAttribution.skills')} rows={data.skills} callsLabel={calls} />
        <Section title={t('settings:usageAttribution.mcp')} rows={data.mcpServers} callsLabel={calls} />
        <Section title={t('settings:usageAttribution.plugins')} rows={data.plugins} callsLabel={calls} />
        {data.unused.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              {t('settings:usageAttribution.unused')}
            </div>
            {data.unused.map((u) => (
              <div key={`${u.kind}:${u.name}`} className="flex justify-between gap-3 text-sm">
                <span className="truncate">{u.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {u.kind}
                  {u.contextTokens !== undefined
                    ? ` · ${t('settings:usageAttribution.approxTokens', {
                        n: u.contextTokens,
                      })}`
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
