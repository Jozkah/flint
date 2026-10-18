import { useEffect, useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { HelpTip } from '@/containers/DetailsCard'
import { StatusChip, type StatusTone } from '@/containers/StatusChip'
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

const OUTCOME_TONE: Record<VerifyReport['outcome'], StatusTone> = {
  passed: 'success',
  failed: 'destructive',
  cancelled: 'neutral',
  error: 'destructive',
}

export function StepList({ steps }: { steps: StepRecord[] }) {
  const { t } = useTranslation()
  return (
    <ol data-testid="bv-steps" className="flex flex-col gap-1 text-xs">
      {steps.filter(Boolean).map((s) => (
        <li key={s.index} data-status={s.status} className="flex min-w-0 gap-2">
          <span className={cn('w-14 shrink-0 font-medium', STATUS_TONE[s.status])}>
            {t(`common:browserVerify.status.${s.status}`)}
          </span>
          <span className="min-w-0 break-words" title={s.detail ?? s.label}>
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
    <div data-testid="bv-evidence" data-outcome={report.outcome} className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={OUTCOME_TONE[report.outcome]}>
          {t(`common:browserVerify.outcome.${report.outcome}`)}
        </StatusChip>
        <span className="min-w-0 break-words text-muted-foreground">{report.reason}</span>
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
        <a className="w-fit break-all text-acc-text underline underline-offset-2" href={report.url} target="_blank" rel="noopener noreferrer">
          {report.url}
        </a>
      )}
      <StepList steps={report.steps} />
      {report.console_errors.length > 0 && (
        <details data-testid="bv-console">
          <summary className="cursor-pointer text-destructive">
            {t('common:browserVerify.consoleErrors', { count: report.console_errors.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
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
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
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
          className="max-h-64 w-full rounded-lg border border-border object-contain object-top"
        />
      )}
    </div>
  )
}

/**
 * "Verify in browser" in the Cowork Preview: open the local app in a
 * separate, throwaway browser confined to its origin, follow the steps, and
 * bring back evidence. Flint's own preview is left exactly as it was.
 *
 * A disclosure: open while the panel has nothing else to show, folded to its
 * title row over a file preview so the artifact keeps the room.
 */
export function BrowserVerifyPanel({
  sessionId,
  detect = detectBrowser,
  defaultOpen = true,
}: {
  sessionId: string | null | undefined
  detect?: () => Promise<BrowserInfo>
  defaultOpen?: boolean
}) {
  const { t } = useTranslation()
  const draftUrl = useBrowserVerify((s) => s.draftUrl)
  const running = useBrowserVerify((s) => (sessionId ? s.running[sessionId] : undefined))
  const latest = useBrowserVerify((s) => (sessionId ? s.reports[sessionId]?.[0] : undefined))
  const [url, setUrl] = useState(draftUrl ?? 'http://localhost:5173/')
  const [stepsText, setStepsText] = useState('')
  const [browser, setBrowser] = useState<BrowserInfo | null>(null)
  const ids = useId()

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
    <details
      // A URL handed over from the web preview is a request to run it: open.
      open={defaultOpen || Boolean(draftUrl) || undefined}
      data-testid="browser-verify"
      aria-label={t('common:browserVerify.title')}
      className="group/bv shrink-0 border-b border-dashed border-border px-4 py-2 text-xs"
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <h3 className="text-[13px] leading-5 font-medium text-foreground">
          {t('common:browserVerify.title')}
        </h3>
        <HelpTip label={t('common:browserVerify.about')}>
          {t('common:browserVerify.explain')}
        </HelpTip>
        {/* The last outcome on the folded row, so a closed disclosure still
            says how the last run went. */}
        {!running && latest && (
          <StatusChip tone={OUTCOME_TONE[latest.outcome]} className="ml-1 group-open/bv:hidden">
            {t(`common:browserVerify.outcome.${latest.outcome}`)}
          </StatusChip>
        )}
        <ChevronDown
          aria-hidden
          className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-open/bv:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-3 pt-1 pb-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-url`} className="text-xs text-muted-foreground">
            {t('common:browserVerify.url')}
          </label>
          <Input
            id={`${ids}-url`}
            data-testid="bv-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={!urlOk && url ? true : undefined}
            className="font-mono"
            spellCheck={false}
          />
          {!urlOk && url && (
            <span className="text-destructive">{t('common:browserVerify.notLocal')}</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-steps`} className="text-xs text-muted-foreground">
            {t('common:browserVerify.stepsLabel')}
          </label>
          <Textarea
            id={`${ids}-steps`}
            data-testid="bv-steps-input"
            value={stepsText}
            onChange={(e) => setStepsText(e.target.value)}
            rows={3}
            aria-describedby={`${ids}-steps-hint`}
            aria-invalid={parsed.error ? true : undefined}
            placeholder={'click: Sign in\ntype: Email = demo@example.com\nexpect: Welcome'}
            className="min-h-0 font-mono"
            spellCheck={false}
          />
          <span id={`${ids}-steps-hint`} className="text-xs text-subtle-foreground">
            {t('common:browserVerify.stepsHint')}
          </span>
          {parsed.error && <span className="text-destructive">{parsed.error}</span>}
        </div>
        {browser && !browser.found && (
          <div data-testid="bv-no-browser" className="flex flex-col items-start gap-2 rounded-lg bg-warning-tint px-2.5 py-2">
            <span className="text-fg-2">{browser.hint ?? t('common:browserVerify.noBrowser')}</span>
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground">
              <span className="min-w-0 break-words">
                {t('common:browserVerify.using', { browser: browser.name ?? '' })}
              </span>
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs text-secondary-foreground underline underline-offset-2 hover:text-foreground"
                data-testid="bv-choose-other-browser"
                onClick={() => void chooseBrowser()}
              >
                {t('common:browserVerify.chooseDifferentBrowser')}
              </Button>
            </span>
          )}
        </div>
        {running && <StepList steps={running.steps} />}
        {!running && latest && <BrowserVerifyEvidence report={latest} />}
      </div>
    </details>
  )
}
