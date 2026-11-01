import { useEffect, useRef, useState } from 'react'
import { Loader2, Search, Wrench } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { errorText } from '@/lib/errorText'
import {
  reviewFixTask,
  runDiffReview,
  type DiffReviewResult,
} from '@/lib/coworkReview'

const SEVERITY_STYLE = {
  high: 'bg-destructive-tint text-destructive',
  medium: 'bg-warning-tint text-warning',
  low: 'bg-muted text-fg-2',
} as const

/**
 * Review the current changes with a fresh-context reviewer, a second pass that
 * tries to refute each finding, and a ranked list. "Fix with agent" sends the
 * findings to the session as an ordinary message, so every edit goes through
 * its normal tools and approvals.
 */
export function CoworkReviewAction({
  folder,
  sessionId,
  onFix,
}: {
  folder: string
  sessionId: string
  /** Send text to the session; false when it is busy. */
  onFix: (text: string) => boolean
}) {
  const { t } = useTranslation()
  const [security, setSecurity] = useState(false)
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running'; done: number; total: number }
    | { kind: 'done'; result: DiffReviewResult }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [fixNotice, setFixNotice] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Leaving the panel stops a review still running (F8x2-006).
  useEffect(() => () => abortRef.current?.abort(), [])

  const run = async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setFixNotice(null)
    setState({ kind: 'running', done: 0, total: 0 })
    try {
      const result = await runDiffReview({
        folder,
        sessionId,
        security,
        signal: controller.signal,
        onProgress: (done, total) => setState({ kind: 'running', done, total }),
      })
      if (!controller.signal.aborted) setState({ kind: 'done', result })
    } catch (e) {
      if (!controller.signal.aborted) {
        setState({ kind: 'error', message: errorText(e) })
      }
    }
  }

  const fix = async (result: DiffReviewResult) => {
    try {
      const sent = onFix(await reviewFixTask(result.findings))
      setFixNotice(sent ? null : t('common:diffReview.fixBusy'))
    } catch (e) {
      setFixNotice(errorText(e))
    }
  }

  const running = state.kind === 'running'
  return (
    <section
      className="flex flex-col gap-2 border-b border-border px-3 py-2"
      aria-label={t('common:diffReview.title')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Search size={14} aria-hidden />
          )}
          {running ? t('common:diffReview.running') : t('common:diffReview.button')}
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={security}
            disabled={running}
            onChange={(e) => setSecurity(e.target.checked)}
          />
          {t('common:diffReview.security')}
        </label>
        {running && state.total > 0 && (
          <span className="text-xs text-muted-foreground">
            {t('common:diffReview.progress', {
              done: state.done + 1,
              total: state.total,
            })}
          </span>
        )}
      </div>
      {state.kind === 'error' && (
        <p role="alert" className="text-xs text-destructive break-words">
          {t('common:diffReview.failed', { error: state.message })}
        </p>
      )}
      {state.kind === 'done' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {t('common:diffReview.summary', {
              count: state.result.findings.length,
              files: state.result.files,
              refuted: state.result.refuted,
            })}
          </p>
          {state.result.truncated && (
            <p className="text-xs text-warning">{t('common:diffReview.truncated')}</p>
          )}
          {state.result.findings.length === 0 ? (
            <p className="text-xs">{t('common:diffReview.none')}</p>
          ) : (
            <>
              <ol
                className="flex flex-col gap-2"
                aria-label={t('common:diffReview.listLabel')}
              >
                {state.result.findings.map((f, i) => (
                  <li key={`${f.file}:${f.line}:${i}`} className="text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 font-medium ${SEVERITY_STYLE[f.severity]}`}
                      >
                        {t(`common:diffReview.severity.${f.severity}`)}
                      </span>
                      <span className="font-mono break-all">
                        {f.file}
                        {f.line ? `:${f.line}` : ''}
                      </span>
                      {f.verdict === 'unverified' && (
                        <span className="text-muted-foreground">
                          {t('common:diffReview.unverified')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 break-words">{f.problem}</p>
                    {f.fix && (
                      <p className="mt-0.5 break-words text-muted-foreground">
                        {t('common:diffReview.fix', { fix: f.fix })}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => void fix(state.result)}
                >
                  <Wrench size={14} aria-hidden />
                  {t('common:diffReview.fixButton')}
                </Button>
              </div>
              {fixNotice && <p className="text-xs text-warning">{fixNotice}</p>}
            </>
          )}
        </div>
      )}
    </section>
  )
}
