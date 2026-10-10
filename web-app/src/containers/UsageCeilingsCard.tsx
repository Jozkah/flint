import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'

export type UsageStanding = {
  ceiling: string
  used: number
  limit: number
  freesInSecs: number | null
}

export type UsageCeilings = {
  tokensPer5h: number | null
  tokensPerWeek: number | null
  standings: UsageStanding[]
}

/** `4h 12m`, `35m`, `50s`, `2d 3h`: how long until capacity comes back. */
export function formatWait(secs: number): string {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${secs}s`
}

/** A blank field removes the ceiling; anything else must be a whole number. */
export function parseCeiling(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return n > 0 ? n : null
}

const STANDING_FOR = {
  fiveHour: 'tokens per 5 hours',
  week: 'tokens per week',
} as const

function Meter({
  label,
  standing,
  noLimit,
  resets,
}: {
  label: string
  standing?: UsageStanding
  noLimit: string
  resets: (wait: string) => string
}) {
  if (!standing) {
    return (
      <div className="space-y-1">
        <p className="text-[13px] font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{noLimit}</p>
      </div>
    )
  }
  const share = Math.min(
    100,
    (standing.used / Math.max(1, standing.limit)) * 100
  )
  return (
    <div className="space-y-1.5" data-testid="usage-meter">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium">{label}</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {standing.used.toLocaleString('en-US')} /{' '}
          {standing.limit.toLocaleString('en-US')}
        </p>
      </div>
      <Progress value={share} />
      {standing.freesInSecs !== null && standing.used > 0 && (
        <p className="text-xs text-muted-foreground">
          {resets(formatWait(standing.freesInSecs))}
        </p>
      )}
    </div>
  )
}

/**
 * Rolling token ceilings for everything Flint spends: agent runs and answers
 * from the local API server. The window rolls, so each use counts for exactly
 * 5 hours (or 7 days) after it happened.
 */
export function UsageCeilingsCard() {
  const { t } = useTranslation()
  const [ceilings, setCeilings] = useState<UsageCeilings | null>(null)
  const [fiveHour, setFiveHour] = useState('')
  const [week, setWeek] = useState('')
  const [saving, setSaving] = useState(false)

  const apply = useCallback((next: UsageCeilings) => {
    setCeilings(next)
    setFiveHour(next.tokensPer5h?.toString() ?? '')
    setWeek(next.tokensPerWeek?.toString() ?? '')
  }, [])

  const refresh = useCallback(async () => {
    try {
      apply(await invoke<UsageCeilings>('get_usage_ceilings'))
    } catch (e) {
      toast.error(errorText(e))
    }
  }, [apply])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  const save = async () => {
    const parsedFiveHour = parseCeiling(fiveHour)
    const parsedWeek = parseCeiling(week)
    if (parsedFiveHour === undefined || parsedWeek === undefined) {
      toast.error(
        t('settings:localApiServer.usageCeilingsInvalid', {
          defaultValue:
            'Limits are whole numbers of tokens. Leave a field empty for no limit.',
        })
      )
      return
    }
    setSaving(true)
    try {
      apply(
        await invoke<UsageCeilings>('set_usage_ceilings', {
          tokensPer5h: parsedFiveHour,
          tokensPerWeek: parsedWeek,
        })
      )
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const find = (name: string) =>
    ceilings?.standings.find((s) => s.ceiling === name)
  const noLimit = t('settings:localApiServer.usageNoLimit', {
    defaultValue: 'No limit set',
  })
  const resets = (wait: string) =>
    t('settings:localApiServer.usageResets', {
      defaultValue: 'Oldest use ages out in {{wait}}',
      wait,
    })
  const label5h = t('settings:localApiServer.usage5h', {
    defaultValue: 'Per 5 hours',
  })
  const labelWeek = t('settings:localApiServer.usageWeek', {
    defaultValue: 'Per week',
  })

  return (
    <Card
      title={t('settings:localApiServer.usageCeilings', {
        defaultValue: 'Token limits',
      })}
      description={t('settings:localApiServer.usageCeilingsDesc', {
        defaultValue:
          'Rolling windows over agent runs and the local API server. A client that reaches a limit gets a 429 with Retry-After.',
      })}
      anchor="settings-local-api-server-usage-ceilings"
    >
      <CardItem
        title={label5h}
        description={t('settings:localApiServer.usage5hDesc', {
          defaultValue:
            'Tokens, input plus output, in the last 5 hours. Empty means no limit.',
        })}
        actions={
          <Input
            inputMode="numeric"
            value={fiveHour}
            onChange={(e) => setFiveHour(e.target.value)}
            aria-label="Tokens per 5 hours"
            className="h-8 w-36 text-sm"
          />
        }
      />
      <CardItem
        title={labelWeek}
        description={t('settings:localApiServer.usageWeekDesc', {
          defaultValue:
            'Tokens, input plus output, in the last 7 days. Empty means no limit.',
        })}
        actions={
          <Input
            inputMode="numeric"
            value={week}
            onChange={(e) => setWeek(e.target.value)}
            aria-label="Tokens per week"
            className="h-8 w-36 text-sm"
          />
        }
      />
      <CardItem
        column
        title={t('settings:localApiServer.usageNow', {
          defaultValue: 'Used now',
        })}
        actions={
          <div className="w-full space-y-3">
            <Meter
              label={label5h}
              standing={find(STANDING_FOR.fiveHour)}
              noLimit={noLimit}
              resets={resets}
            />
            <Meter
              label={labelWeek}
              standing={find(STANDING_FOR.week)}
              noLimit={noLimit}
              resets={resets}
            />
            <Button
              onClick={save}
              disabled={saving}
              className="pointer-coarse:h-11"
            >
              {t('common:save', { defaultValue: 'Save' })}
            </Button>
          </div>
        }
      />
    </Card>
  )
}
