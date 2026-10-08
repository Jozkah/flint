import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  detectBrowser,
  isLocalAppUrl,
  parseSteps,
  setBrowserPath,
  type BrowserInfo,
  type StepRecord,
  type VerifyReport,
} from '@/lib/browserVerify'

const STATUS_TONE: Record<StepRecord['status'], string> = {
  pending: 'text-muted-foreground',
  running: 'text-warning',
  passed: 'text-success',
  failed: 'text-destructive',
  skipped: 'text-subtle-foreground',
}

const OUTCOME_TONE: Record<VerifyReport['outcome'], string> = {
  passed: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  error: 'text-destructive',
}

export function StepList({ steps }: { steps: StepRecord[] }) {
  const { t } = useTranslation()
  return (
    <ol data-testid="bv-steps" className="flex flex-col gap-0.5 text-xs">
      {steps.filter(Boolean).map((s) => (
        <li key={s.index} data-status={s.status} className="flex min-w-0 gap-1.5">
          <span className={cn('shrink-0 font-medium', STATUS_TONE[s.status])}>
            {t(`common:browserVerify.status.${s.status}`)}
          </span>
          <span className="min-w-0 truncate" title={s.detail ?? s.label}>
            {s.label}
            {s.detail ? <span className="text-muted-foreground"> · {s.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** One run's evidence: outcome, steps, screenshot, console, blocked requests. */
export function BrowserVerifyEvidence({ report }: { report: VerifyReport }) {
  const { t } = useTranslation()
  const last = report.screenshots[report.screenshots.length - 1]
  return (
    <div data-testid="bv-evidence" data-outcome={report.outcome} className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn('font-medium', OUTCOME_TONE[report.outcome])}>
          {t(`common:browserVerify.outcome.${report.outcome}`)}
        </span>
        <span className="text-muted-foreground">{report.reason}</span>
      </div>
      <span className="text-subtle-foreground">
        {t('common:browserVerify.meta', {
          origin: report.origin,
          browser: report.browser ?? '—',
          date: new Date(report.started_at).toLocaleString(),
          ms: report.duration_ms,
        })}
        {report.document_status != null ? ` · HTTP ${report.document_status}` : ''}
      </span>
      {isLocalAppUrl(report.url) && (
        <a className="w-fit text-acc-text underline underline-offset-2" href={report.url} target="_blank" rel="noopener noreferrer">
          {report.url}
        </a>
      )}
      <StepList steps={report.steps} />
      {report.console_errors.length > 0 && (
        <details data-testid="bv-console">
          <summary className="cursor-pointer text-destructive">
            {t('common:browserVerify.consoleErrors', { count: report.console_errors.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px]">
            {report.console_errors.map((c, i) => (
              <li key={i} className="break-words">{c.text}</li>
            ))}
          </ul>
        </details>
      )}
      {report.blocked_requests.length > 0 && (
        <details data-testid="bv-blocked">
          <summary className="cursor-pointer text-muted-foreground">
            {t('common:browserVerify.blocked', { count: report.blocked_requests.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px]">
            {report.blocked_requests.map((b, i) => (
              <li key={i} className="break-all">
                {b.navigation ? '⛔ ' : ''}
                {b.resource_type} · {b.url}
              </li>
            ))}
          </ul>
        </details>
      )}
      {last && (
        <img
          data-testid="bv-screenshot"
          alt={t('common:browserVerify.screenshotAlt')}
          src={`data:image/png;base64,${last.png_base64}`}
          className="max-h-64 w-full rounded border border-border object-contain object-top"
        />
      )}
    </div>
  )
}

/**
 * "Verify in browser" in the Cowork Preview: open the local app in a
 * separate, throwaway browser confined to its origin, follow the steps, and
 * bring back evidence. Flint's own preview is left exactly as it was.
 */
export function BrowserVerifyPanel({
  sessionId,
  detect = detectBrowser,
}: {
  sessionId: string | null | undefined
  detect?: () => Promise<BrowserInfo>
}) {
  const { t } = useTranslation()
  const draftUrl = useBrowserVerify((s) => s.draftUrl)
  const running = useBrowserVerify((s) => (sessionId ? s.running[sessionId] : undefined))
  const latest = useBrowserVerify((s) => (sessionId ? s.reports[sessionId]?.[0] : undefined))
  const [url, setUrl] = useState(draftUrl ?? 'http://localhost:5173/')
  const [stepsText, setStepsText] = useState('')
  const [browser, setBrowser] = useState<BrowserInfo | null>(null)

  useEffect(() => {
    if (!draftUrl) return
    setUrl(draftUrl)
    useBrowserVerify.getState().setDraftUrl(null)
  }, [draftUrl])

  useEffect(() => {
    let alive = true
    detect()
      .then((b) => alive && setBrowser(b))
      .catch(() => alive && setBrowser({ found: false, path: null, name: null, hint: null }))
    return () => {
      alive = false
    }
  }, [detect])

  // A cancelled dialog is silent; a path the desktop refuses ("no file at ...",
  // "must be absolute") is the user's to fix, so say so.
  const chooseBrowser = async () => {
    try {
      const picked = await getServiceHub().dialog().open({
        multiple: false,
        directory: false,
      })
      if (typeof picked !== 'string' || !picked) return
      setBrowser(await setBrowserPath(picked))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const parsed = parseSteps(stepsText)
  const urlOk = isLocalAppUrl(url)
  const canRun = !!sessionId && !running && urlOk && !parsed.error && browser?.found === true

  return (
    <section
      data-testid="browser-verify"
      aria-label={t('common:browserVerify.title')}
      className="flex flex-col gap-2 border-b border-border px-3 py-3 text-xs"
    >
      <h3 className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
        {t('common:browserVerify.title')}
      </h3>
      <p className="text-muted-foreground">{t('common:browserVerify.explain')}</p>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">{t('common:browserVerify.url')}</span>
        <input
          data-testid="bv-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="rounded border border-border bg-card px-2 py-1 font-mono"
          spellCheck={false}
        />
      </label>
      {!urlOk && url && (
        <span className="text-destructive">{t('common:browserVerify.notLocal')}</span>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">{t('common:browserVerify.steps')}</span>
        <textarea
          data-testid="bv-steps-input"
          value={stepsText}
          onChange={(e) => setStepsText(e.target.value)}
          rows={4}
          placeholder={'click: Sign in\ntype: Email = demo@example.com\nexpect: Welcome'}
          className="rounded border border-border bg-card px-2 py-1 font-mono"
          spellCheck={false}
        />
      </label>
      {parsed.error && <span className="text-destructive">{parsed.error}</span>}
      {browser && !browser.found && (
        <div data-testid="bv-no-browser" className="flex flex-col gap-1.5">
          <span className="text-destructive">{browser.hint ?? t('common:browserVerify.noBrowser')}</span>
          <Button
            size="sm"
            variant="outline"
            data-testid="bv-choose-browser"
            onClick={() => void chooseBrowser()}
          >
            {t('common:browserVerify.chooseBrowser')}
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        {running ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="bv-cancel"
            onClick={() => sessionId && void useBrowserVerify.getState().cancel(sessionId)}
          >
            {t('common:browserVerify.cancel')}
          </Button>
        ) : (
          <Button
            size="sm"
            data-testid="bv-run"
            disabled={!canRun}
            onClick={() =>
              sessionId &&
              void useBrowserVerify.getState().start(sessionId, url.trim(), parsed.steps).catch(() => undefined)
            }
          >
            {t('common:browserVerify.run')}
          </Button>
        )}
        {browser?.found && (
          <span className="text-subtle-foreground">
            {t('common:browserVerify.using', { browser: browser.name ?? '' })}
          </span>
        )}
        {browser?.found && (
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            data-testid="bv-choose-other-browser"
            onClick={() => void chooseBrowser()}
          >
            {t('common:browserVerify.chooseDifferentBrowser')}
          </Button>
        )}
      </div>
      {running && <StepList steps={running.steps} />}
      {!running && latest && <BrowserVerifyEvidence report={latest} />}
    </section>
  )
}
