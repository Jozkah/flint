import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { currentDoctorResult, doctorKey, useModelDoctor } from '@/hooks/useModelDoctor'
import { ModelFactory } from '@/lib/model-factory'
import { probeModelParams } from '@/lib/modelDoctorParams'
import { unloadLlamaModel } from '@janhq/tauri-plugin-llamacpp-api'
import type { ProbeCheck } from '@/lib/modelDoctor'

const CHECK_TONE = (ok: boolean | null) =>
  ok === true ? 'text-success' : ok === false ? 'text-destructive' : 'text-muted-foreground'

/**
 * "Test this model": the observed half of the readiness card's model row.
 *
 * The declared flag ("supports tools") stays where it was; this adds what a
 * probe through the real transport observed, when, and under which
 * settings -- and says plainly that one passing probe is not a promise that
 * every task will work.
 */
export function ModelDoctor({
  provider,
  model,
  createModel = (p, m) => ModelFactory.createModel(m.id, p, probeModelParams(p, m)),
}: {
  provider: ProviderObject | undefined
  model: Model | undefined
  /** The transport the run uses; injectable for tests. */
  createModel?: (provider: ProviderObject, model: Model) => ReturnType<typeof ModelFactory.createModel>
}) {
  const { t } = useTranslation()
  const results = useModelDoctor((s) => s.results)
  const running = useModelDoctor((s) =>
    provider && model ? Boolean(s.running[doctorKey(provider.provider, model.id)]) : false
  )
  const [open, setOpen] = useState(false)
  if (!provider || !model) return null
  const current = currentDoctorResult(results, provider, model)
  const result = current?.result

  const run = () => {
    setOpen(true)
    void useModelDoctor
      .getState()
      .test(provider, model, () => createModel(provider, model), {
        // A load given up on is not left running in the background.
        abandonLoad:
          provider.provider === 'llamacpp'
            ? () => void unloadLlamaModel(model.id).catch(() => undefined)
            : undefined,
      })
      .catch(() => undefined)
  }

  return (
    <div data-testid="model-doctor" className="flex flex-col gap-1 whitespace-normal">
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <>
            <span className="text-muted-foreground">{t('common:modelDoctor.running')}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => useModelDoctor.getState().cancel(provider.provider, model.id)}
            >
              {t('common:modelDoctor.cancel')}
            </Button>
          </>
        ) : (
          <>
            {result && !current?.stale && (
              <button
                type="button"
                data-testid="model-doctor-verdict"
                data-outcome={result.outcome}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                  'cursor-pointer hover:underline',
                  result.outcome === 'passed' ? 'text-success' : 'text-destructive'
                )}
              >
                {t(
                  result.outcome === 'passed'
                    ? 'common:modelDoctor.passed'
                    : 'common:modelDoctor.failed',
                  { date: new Date(result.testedAt).toLocaleString() }
                )}
              </button>
            )}
            {current?.stale && (
              <span data-testid="model-doctor-stale" className="text-muted-foreground">
                {t('common:modelDoctor.stale')}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              data-testid="model-doctor-test"
              onClick={run}
            >
              {result ? t('common:modelDoctor.retest') : t('common:modelDoctor.test')}
            </Button>
          </>
        )}
      </div>
      {open && result && !current?.stale && (
        <div data-testid="model-doctor-report" className="flex flex-col gap-0.5 text-xs">
          <ul className="flex flex-col gap-0.5">
            {result.checks.map((c: ProbeCheck) => (
              <li key={c.id} data-check={c.id} data-ok={String(c.ok)}>
                <span className={cn('font-medium', CHECK_TONE(c.ok))}>
                  {t(`common:modelDoctor.check.${c.id}`)}
                </span>
                {' · '}
                <span className="text-muted-foreground">{c.detail}</span>
              </li>
            ))}
          </ul>
          <span className="text-subtle-foreground" title={result.settingsSummary}>
            {t('common:modelDoctor.fingerprint', {
              fingerprint: result.fingerprint.slice(0, 8),
              ms: result.durationMs,
            })}
          </span>
          <span className="text-subtle-foreground">{t('common:modelDoctor.limits')}</span>
        </div>
      )}
    </div>
  )
}
