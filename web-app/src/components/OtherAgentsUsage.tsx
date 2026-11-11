import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { invokeCommand } from '@/lib/backend'
import { hasTauriRuntime } from '@/lib/providerFetch'
import { useUsageImport } from '@/stores/usage-import-store'
import {
  IMPORT_AGENTS,
  compactTokens,
  dailyTotals,
  formatCost,
  formatRate,
  isEmptyScan,
  parsePriceDraft,
  rootProblems,
  toggleAgent,
  type ImportAgent,
  type ModelRow,
  type PriceDraft,
  type UsageImportResponse,
} from '@/lib/usageImport'

const AGENT_KEY: Record<ImportAgent, string> = {
  'claude-code': 'otherAgents.agentClaudeCode',
  codex: 'otherAgents.agentCodex',
  flint: 'otherAgents.agentFlint',
}

type Roots = { claudeCode: string; codex: string }

/** A small line of one model's daily tokens, scaled to its own maximum. */
function Trend({ values }: { values: number[] }) {
  if (values.length < 2) return <span aria-hidden className="text-muted-foreground">—</span>
  const w = 80
  const h = 22
  const max = Math.max(...values, 1)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[22px] w-[80px]" aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function PriceForm({ model, onDone }: { model: string; onDone: () => void }) {
  const { t } = useTranslation()
  const existing = useUsageImport((s) => s.prices[model])
  const setPrice = useUsageImport((s) => s.setPrice)
  const [d, setD] = useState<PriceDraft>({
    input: existing ? String(existing.input) : '',
    output: existing ? String(existing.output) : '',
    cacheRead: existing?.cache_read !== undefined ? String(existing.cache_read) : '',
    cacheWrite: existing?.cache_write !== undefined ? String(existing.cache_write) : '',
  })
  const parsed = parsePriceDraft(d)
  const field = (key: keyof PriceDraft, label: string) => (
    <label className="flex flex-col gap-1 text-xs text-secondary-foreground">
      {label}
      <Input
        inputMode="decimal"
        value={d[key]}
        onChange={(e) => setD({ ...d, [key]: e.target.value })}
        data-testid={`usage-import-price-${key}`}
      />
    </label>
  )
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="usage-import-price-form">
      <p className="m-0 text-xs text-secondary-foreground">
        {t('overview:otherAgents.priceHint', { model })}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {field('input', t('overview:otherAgents.priceInput'))}
        {field('output', t('overview:otherAgents.priceOutput'))}
        {field('cacheRead', t('overview:otherAgents.priceCacheRead'))}
        {field('cacheWrite', t('overview:otherAgents.priceCacheWrite'))}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!parsed}
          onClick={() => {
            if (parsed) setPrice(model, parsed)
            onDone()
          }}
        >
          {t('overview:otherAgents.priceSave')}
        </Button>
        {existing && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setPrice(model, null)
              onDone()
            }}
          >
            {t('overview:otherAgents.priceClear')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('overview:otherAgents.cancel')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Token usage read from other coding agents' local logs, beside Flint's own.
 * Off until switched on; nothing is read before that.
 */
export function OtherAgentsUsage() {
  const { t } = useTranslation()
  const { enabled, days, agents, prices, setEnabled, setDays, setAgents } = useUsageImport()
  const [roots, setRoots] = useState<Roots | null>(null)
  const [data, setData] = useState<UsageImportResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const desktop = hasTauriRuntime()

  useEffect(() => {
    if (!desktop) return
    invokeCommand<Roots>('usage_import_roots').then(setRoots).catch(() => {})
  }, [desktop])

  const load = useCallback(
    async (rescan: boolean) => {
      setBusy(true)
      setError(null)
      const args = { consent: true, query: { days, agents }, prices }
      try {
        let res: UsageImportResponse | null = null
        if (!rescan) {
          res = await invokeCommand<UsageImportResponse>('usage_import_report', args).catch(() => null)
        }
        res ??= await invokeCommand<UsageImportResponse>('usage_import_scan', args)
        setData(res)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
        setProgress(null)
      }
    },
    [days, agents, prices]
  )

  useEffect(() => {
    if (!desktop || !enabled) return
    void load(false)
  }, [desktop, enabled, load])

  useEffect(() => {
    if (!desktop || !enabled) return
    let off: (() => void) | undefined
    let live = true
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ done: number; total: number }>('usage-import-progress', (e) => setProgress(e.payload))
      )
      .then((u) => (live ? (off = u) : u()))
      .catch(() => {})
    return () => {
      live = false
      off?.()
    }
  }, [desktop, enabled])

  const toggle = (on: boolean) => {
    setEnabled(on)
    if (!on) {
      setData(null)
      invokeCommand('usage_import_forget').catch(() => {})
    }
  }

  const report = data?.report ?? null
  const problems = rootProblems(data?.summary ?? null)
  const daily = useMemo(() => dailyTotals(report?.byDay ?? []), [report])
  const maxDay = Math.max(...daily.map((d) => d.total), 1)
  const agentLabel = (a: ImportAgent) => t(`overview:${AGENT_KEY[a]}`)

  if (!desktop) return null

  const stat = (label: string, value: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-secondary-foreground">{label}</span>
      <span className="text-lg font-medium tabular-nums">{value}</span>
    </div>
  )

  return (
    <section className="flex flex-col gap-4 rounded-xl border p-4" data-testid="other-agents-usage">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-sm font-medium">{t('overview:otherAgents.title')}</h3>
          <p className="m-0 text-xs text-secondary-foreground">{t('overview:otherAgents.intro')}</p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          {t('overview:otherAgents.enable')}
          <Switch checked={enabled} onCheckedChange={toggle} data-testid="usage-import-toggle" />
        </label>
      </div>

      {!enabled && (
        <div className="flex flex-col gap-1 text-xs text-secondary-foreground" data-testid="usage-import-off">
          <p className="m-0">{t('overview:otherAgents.foldersIntro')}</p>
          <ul className="m-0 list-disc pl-5">
            <li className="break-all">{roots?.claudeCode ?? '~/.claude/projects'}</li>
            <li className="break-all">{roots?.codex ?? '~/.codex/sessions'}</li>
          </ul>
          <p className="m-0">{t('overview:otherAgents.keptNote')}</p>
        </div>
      )}

      {enabled && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {IMPORT_AGENTS.map((a) => (
              <Button
                key={a}
                size="sm"
                variant={agents.includes(a) ? 'default' : 'outline'}
                aria-pressed={agents.includes(a)}
                onClick={() => setAgents(toggleAgent(agents, a))}
              >
                {agentLabel(a)}
              </Button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {([7, 30, 90, 0] as const).map((n) => (
              <Button
                key={n}
                size="sm"
                variant={days === n ? 'default' : 'outline'}
                aria-pressed={days === n}
                onClick={() => setDays(n)}
              >
                {n === 0 ? t('overview:otherAgents.rangeAll') : t(`overview:otherAgents.range${n}`)}
              </Button>
            ))}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(true)} data-testid="usage-import-rescan">
              {busy && progress
                ? t('overview:otherAgents.scanning', { done: progress.done, total: progress.total })
                : t('overview:otherAgents.rescan')}
            </Button>
          </div>

          {error && (
            <p className="m-0 text-xs text-destructive" role="alert">
              {t('overview:otherAgents.scanError', { error })}
            </p>
          )}
          {problems.map((p) => (
            <p key={p.agent} className="m-0 text-xs text-secondary-foreground" data-testid="usage-import-problem">
              {p.status === 'missing'
                ? t('overview:otherAgents.folderMissing', { path: p.path })
                : p.status === 'denied'
                  ? t('overview:otherAgents.folderDenied', { path: p.path })
                  : t('overview:otherAgents.folderError', { path: p.path })}
            </p>
          ))}

          {!busy && data && isEmptyScan(report) && (
            <p className="m-0 text-sm text-secondary-foreground" data-testid="usage-import-empty">
              {t('overview:otherAgents.empty')}
            </p>
          )}

          {report && !isEmptyScan(report) && (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {stat(t('overview:otherAgents.tokens'), compactTokens(report.totals.total))}
                {stat(t('overview:otherAgents.messages'), String(report.totals.messages))}
                {stat(t('overview:otherAgents.cacheHit'), formatRate(report.totals.cacheHitRate))}
                {stat(t('overview:otherAgents.cost'), formatCost(report.totals.cost))}
                {stat(t('overview:otherAgents.input'), compactTokens(report.totals.input))}
                {stat(t('overview:otherAgents.cacheRead'), compactTokens(report.totals.cacheRead))}
                {stat(t('overview:otherAgents.cacheWrite'), compactTokens(report.totals.cacheWrite))}
                {stat(t('overview:otherAgents.output'), compactTokens(report.totals.output))}
              </div>
              <p className="m-0 text-xs text-secondary-foreground">
                {t('overview:otherAgents.costNote')}
                {report.totals.costPerMtok !== null &&
                  ` ${t('overview:otherAgents.costPerM')}: ${formatCost(report.totals.costPerMtok)}.`}
                {report.totals.unpricedTokens > 0 &&
                  ` ${t('overview:otherAgents.unpricedTokens', { tokens: compactTokens(report.totals.unpricedTokens) })}`}
              </p>

              <div className="flex flex-col gap-1">
                <h4 className="m-0 text-xs font-medium">{t('overview:otherAgents.perDay')}</h4>
                <div className="flex h-16 items-end gap-px" role="img" aria-label={t('overview:otherAgents.perDay')}>
                  {daily.map((d) => (
                    <div
                      key={d.day}
                      title={`${d.day}: ${compactTokens(d.total)}`}
                      className="min-w-px flex-1 rounded-t-sm bg-primary/70"
                      style={{ height: `${Math.max(2, (d.total / maxDay) * 100)}%` }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <h4 className="m-0 text-xs font-medium">{t('overview:otherAgents.byAgent')}</h4>
                {report.byAgent.map((a) => (
                  <div key={a.agent} className="flex items-center justify-between gap-2 text-xs" data-testid="usage-import-agent-row">
                    <span>{agentLabel(a.agent)}</span>
                    <span className="tabular-nums text-secondary-foreground">
                      {compactTokens(a.total)} · {formatRate(a.cacheHitRate)} · {formatCost(a.cost)}
                    </span>
                  </div>
                ))}
                {report.byAgent.some((a) => a.agent === 'flint') && (
                  <p className="m-0 text-xs text-secondary-foreground">{t('overview:otherAgents.flintNote')}</p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <h4 className="m-0 text-xs font-medium">{t('overview:otherAgents.byModel')}</h4>
                {report.byModel.map((m: ModelRow) => (
                  <div key={`${m.agent}:${m.model}`} className="flex flex-col gap-2" data-testid="usage-import-model-row">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{m.model}</span>
                        <span className="text-secondary-foreground">{agentLabel(m.agent)}</span>
                      </div>
                      <Trend values={m.trend} />
                      <span className="tabular-nums text-secondary-foreground">
                        {compactTokens(m.total)} · {t('overview:otherAgents.cacheHit')} {formatRate(m.cacheHitRate)} ·{' '}
                        {m.priced ? (
                          <>
                            {formatCost(m.cost)} ({formatCost(m.costPerMtok)} / 1M)
                          </>
                        ) : (
                          <span data-testid="usage-import-unpriced">{t('overview:otherAgents.unpriced')}</span>
                        )}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(editing === m.model ? null : m.model)}>
                        {t('overview:otherAgents.setPrice')}
                      </Button>
                    </div>
                    {editing === m.model && <PriceForm model={m.model} onDone={() => setEditing(null)} />}
                  </div>
                ))}
              </div>
            </>
          )}

          {data && (
            <p className="m-0 text-xs text-secondary-foreground" data-testid="usage-import-footnote">
              {t('overview:otherAgents.scanStats', {
                parsed: data.summary.filesParsed,
                cached: data.summary.filesCached,
                skipped: data.summary.skippedLines,
                duplicates: data.summary.duplicates,
              })}
              {data.summary.roots.some((r) => r.compressedSkipped > 0) &&
                ` ${t('overview:otherAgents.compressedSkipped', {
                  count: data.summary.roots.reduce((n, r) => n + r.compressedSkipped, 0),
                })}`}
            </p>
          )}
        </>
      )}
    </section>
  )
}
