import { useCallback, useEffect, useRef, useState } from 'react'
import { isServedByFlint } from '@/lib/platform/utils'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Card } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import { cn } from '@/lib/utils'

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

/** `used / limit` with a thin bar; "No limit set" when nothing caps the window. */
function Meter({
  standing,
  noLimit,
  resets,
}: {
  standing?: UsageStanding
  noLimit: string
  resets: (wait: string) => string
}) {
  const { i18n } = useTranslation()
  if (!standing) {
    return <p className="text-xs text-muted-foreground">{noLimit}</p>
  }
  const share = Math.min(
    100,
    (standing.used / Math.max(1, standing.limit)) * 100
  )
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="usage-meter">
      <p className="text-xs tabular-nums text-foreground">
        {standing.used.toLocaleString(i18n?.language)} /{' '}
        {standing.limit.toLocaleString(i18n?.language)}
      </p>
      <Progress
        value={share}
        className={cn('h-1', share >= 90 && '[&>[data-slot=progress-indicator]]:bg-destructive')}
      />
      {standing.freesInSecs !== null && standing.used > 0 && (
        <p className="text-xs text-muted-foreground">
          {resets(formatWait(standing.freesInSecs))}
        </p>
      )}
    </div>
  )
}

/**
 * One window of the table: its name with the explanation behind an info
 * mark, the limit field, and how much of the window is spent right now.
 */
function WindowRow({
  label,
  description,
  value,
  onChange,
  inputAria,
  placeholder,
  standing,
  noLimit,
  resets,
}: {
  label: string
  description: string
  value: string
  onChange: (next: string) => void
  inputAria: string
  placeholder: string
  standing?: UsageStanding
  noLimit: string
  resets: (wait: string) => string
}) {
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-x-3 gap-y-1.5 border-b border-dashed border-border py-2.5 last:border-b-0 @md:grid-cols-[minmax(7rem,1fr)_8rem_minmax(9rem,1.2fr)]"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
          {label}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 outline-hidden"
              aria-label={description}
            >
              <Info size={13} aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-64 text-left">
            {description}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="justify-self-end @md:justify-self-stretch">
        <Input
          inputMode="numeric"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={inputAria}
          aria-description={description}
          className="h-8 w-full text-sm tabular-nums"
        />
      </div>
      <div className="col-span-2 @md:col-span-1">
        <Meter standing={standing} noLimit={noLimit} resets={resets} />
      </div>
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
  /** Whether the fields have been filled from the first answer. */
  const loaded = useRef(false)

  const apply = useCallback((next: UsageCeilings) => {
    setCeilings(next)
    setFiveHour(next.tokensPer5h?.toString() ?? '')
    setWeek(next.tokensPerWeek?.toString() ?? '')
  }, [])

  // The limits are kept by the desktop app; a browser has no route to them.
  const served = isServedByFlint()

  const refresh = useCallback(async () => {
    if (served) return
    try {
      const next = await invoke<UsageCeilings>('get_usage_ceilings')
      // A poll must not overwrite a limit the user is in the middle of typing:
      // only the standings move; the fields follow what was last saved.
      if (!loaded.current) {
        loaded.current = true
        setFiveHour(next.tokensPer5h?.toString() ?? '')
        setWeek(next.tokensPerWeek?.toString() ?? '')
      }
      setCeilings(next)
    } catch (e) {
      toast.error(errorText(e))
    }
  }, [served])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  const savedFiveHour = ceilings?.tokensPer5h?.toString() ?? ''
  const savedWeek = ceilings?.tokensPerWeek?.toString() ?? ''
  const dirty = fiveHour !== savedFiveHour || week !== savedWeek

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
  const noLimitPlaceholder = t('settings:localApiServer.usageNoLimitPlaceholder', {
    defaultValue: 'No limit',
  })
  const label5h = t('settings:localApiServer.usage5h', {
    defaultValue: 'Per 5 hours',
  })
  const labelWeek = t('settings:localApiServer.usageWeek', {
    defaultValue: 'Per week',
  })

  if (served) {
    return (
      <Card
      title={t('settings:localApiServer.usageCeilings', {
        defaultValue: 'Token limits',
      })}
      anchor="settings-local-api-server-usage-ceilings"
      >
        <p className="text-sm text-muted-foreground" data-testid="usage-ceilings-desktop-only">
          {t('permissions:desktopOnly')}
        </p>
      </Card>
    )
  }

  const headCell = 'text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[.02em] text-subtle-foreground uppercase'

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
      <TooltipProvider delayDuration={200}>
        <form
          className="@container flex flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div
            aria-hidden
            className="hidden border-b border-dashed border-border pb-1.5 @md:grid @md:grid-cols-[minmax(7rem,1fr)_8rem_minmax(9rem,1.2fr)] @md:gap-x-3"
          >
            <span className={headCell}>
              {t('settings:localApiServer.usageWindow', { defaultValue: 'Window' })}
            </span>
            <span className={headCell}>
              {t('settings:localApiServer.usageLimit', { defaultValue: 'Limit' })}
            </span>
            <span className={headCell}>
              {t('settings:localApiServer.usageNow', { defaultValue: 'Used now' })}
            </span>
          </div>
          <WindowRow
            label={label5h}
            description={t('settings:localApiServer.usage5hDesc', {
              defaultValue:
                'Tokens, input plus output, in the last 5 hours. Empty means no limit.',
            })}
            value={fiveHour}
            onChange={setFiveHour}
            inputAria={t('settings:localApiServer.usage5hAria', {
              defaultValue: 'Tokens per 5 hours',
            })}
            placeholder={noLimitPlaceholder}
            standing={find(STANDING_FOR.fiveHour)}
            noLimit={noLimit}
            resets={resets}
          />
          <WindowRow
            label={labelWeek}
            description={t('settings:localApiServer.usageWeekDesc', {
              defaultValue:
                'Tokens, input plus output, in the last 7 days. Empty means no limit.',
            })}
            value={week}
            onChange={setWeek}
            inputAria={t('settings:localApiServer.usageWeekAria', {
              defaultValue: 'Tokens per week',
            })}
            placeholder={noLimitPlaceholder}
            standing={find(STANDING_FOR.week)}
            noLimit={noLimit}
            resets={resets}
          />
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-dashed border-border pt-3">
            {dirty && (
              <span className="mr-auto text-xs text-muted-foreground">
                {t('settings:localApiServer.usageUnsaved', {
                  defaultValue: 'Unsaved changes',
                })}
              </span>
            )}
            <Button
              type="submit"
              disabled={saving || !dirty}
              className="pointer-coarse:h-11"
            >
              {t('common:save', { defaultValue: 'Save' })}
            </Button>
          </div>
        </form>
      </TooltipProvider>
    </Card>
  )
}
