import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useJevSettings } from '@/hooks/useJevSettings'
import {
  jevClearKey,
  jevReceipts,
  jevSetKey,
  jevStatus,
  type JevMode,
  type JevReceipt,
  type JevStatus,
} from '@/lib/jev'

const MODES: JevMode[] = ['off', 'shadow', 'on']

function ModePicker({
  value,
  onChange,
  label,
  testId,
}: {
  value: JevMode
  onChange: (m: JevMode) => void
  label: string
  testId: string
}) {
  const { t } = useTranslation()
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="inline-flex rounded-md border border-border p-0.5">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          data-mode={m}
          onClick={() => onChange(m)}
          className={cn(
            'rounded px-2.5 py-1 text-xs',
            value === m ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'
          )}
        >
          {t(`common:jev.mode.${m}`)}
        </button>
      ))}
    </div>
  )
}

/**
 * Settings for Jev decision support: the key (write-only, stored in the
 * protected secret store), the two opt-ins -- separate, both off by default
 * -- with exactly what each one sends, and the recent decision receipts.
 */
export function JevSettingsCard({
  api = { jevStatus, jevReceipts, jevSetKey, jevClearKey },
}: {
  api?: {
    jevStatus: typeof jevStatus
    jevReceipts: typeof jevReceipts
    jevSetKey: typeof jevSetKey
    jevClearKey: typeof jevClearKey
  }
}) {
  const { t } = useTranslation()
  const skillMode = useJevSettings((s) => s.skillMode)
  const rerankMode = useJevSettings((s) => s.rerankMode)
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [receipts, setReceipts] = useState<JevReceipt[]>([])
  const [keyInput, setKeyInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void api.jevStatus().then(setStatus).catch(() => setStatus(null))
    void api.jevReceipts().then(setReceipts).catch(() => setReceipts([]))
  }, [api])
  useEffect(refresh, [refresh])

  const saveKey = async () => {
    setError(null)
    try {
      await api.jevSetKey(keyInput.trim())
      // The field is cleared: the key is never shown again, anywhere.
      setKeyInput('')
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <>
    <Card title={t('common:jev.cardKey')}>
      <CardItem
        align="start"
        description={<p className="text-muted-foreground">{t('common:jev.intro', { model: status?.model ?? 'jev-1.13.0' })}</p>}
      />
      <CardItem
        // The field and its buttons get their own line under the text: side
        // by side they overflowed the control column and covered the text.
        column
        anchor="settings-jev-key"
        title={t('common:jev.key')}
        description={
          status?.key_configured ? t('common:jev.keyConfigured') : t('common:jev.keyMissing')
        }
        actions={
          <div className="flex w-full flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              data-testid="jev-key-input"
              aria-label={t('common:jev.key')}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={status?.key_configured ? '••••••••' : 'ts_…'}
              className="h-8 min-w-0 flex-1 basis-48 rounded border border-border bg-card px-2 text-xs"
            />
            <Button size="sm" variant="outline" disabled={!keyInput.trim()} onClick={() => void saveKey()}>
              {t('common:jev.saveKey')}
            </Button>
            {status?.key_configured && (
              <Button size="sm" variant="ghost" onClick={() => void api.jevClearKey().then(refresh)}>
                {t('common:jev.clearKey')}
              </Button>
            )}
          </div>
        }
      />
      {error && <p className="px-4 text-xs text-destructive">{error}</p>}
    </Card>
    <Card title={t('common:jev.cardFeatures')}>
      <CardItem
        anchor="settings-jev-skills"
        align="start"
        title={t('common:jev.skillTitle')}
        description={<p>{t('common:jev.skillSends')}</p>}
        actions={
          <ModePicker
            testId="jev-skill-mode"
            label={t('common:jev.skillTitle')}
            value={skillMode}
            onChange={(m) => useJevSettings.getState().setSkillMode(m)}
          />
        }
      />
      <CardItem
        anchor="settings-jev-rerank"
        align="start"
        title={t('common:jev.rerankTitle')}
        description={<p>{t('common:jev.rerankSends')}</p>}
        actions={
          <ModePicker
            testId="jev-rerank-mode"
            label={t('common:jev.rerankTitle')}
            value={rerankMode}
            onChange={(m) => useJevSettings.getState().setRerankMode(m)}
          />
        }
      />
      <CardItem
        align="start"
        description={<p className="text-muted-foreground">{t('common:jev.modesExplained')}</p>}
      />
    </Card>
    <Card title={t('common:jev.receipts')}>
      <CardItem
        align="start"
        description={
          <div className="flex flex-col gap-1">
            {status && (
              <span className="text-muted-foreground">
                {t('common:jev.budget', {
                  used: status.tokens_used_today.toLocaleString(),
                  budget: status.daily_token_budget.toLocaleString(),
                })}
              </span>
            )}
            {receipts.length === 0 ? (
              <span className="text-muted-foreground">{t('common:jev.noReceipts')}</span>
            ) : (
              <ul data-testid="jev-receipts" className="flex flex-col gap-0.5 font-mono text-[11px]">
                {receipts.slice(0, 20).map((r, i) => (
                  <li key={i} className="break-words">
                    {new Date(r.at).toLocaleTimeString()} · {r.feature} · {r.mode} · {r.model ?? '—'} ·{' '}
                    {r.decision} · {r.latency_ms} ms · {r.input_tokens}/{r.output_tokens} tok
                    {r.fallback ? ` · ${t('common:jev.fallback')}: ${r.fallback}` : ''}
                  </li>
                ))}
              </ul>
            )}
            <Button size="sm" variant="ghost" className="self-start" onClick={refresh}>
              {t('common:jev.refresh')}
            </Button>
          </div>
        }
      />
    </Card>
    </>
  )
}
