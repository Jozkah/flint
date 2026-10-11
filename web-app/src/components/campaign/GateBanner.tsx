import { useState } from 'react'
import { AlertTriangle, Check, Copy } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'

/** The last `n` lines of a check's output, trailing blank lines dropped. */
export function lastLines(output: string, n = 20): string {
  const lines = output.replace(/\s+$/, '').split(/\r?\n/)
  return lines.slice(-n).join('\n')
}

export type GateInfo = {
  command?: string | null
  exitCode?: number | null
  timedOut?: boolean
  output?: string | null
}

/**
 * The final build and test check failed. Said plainly at the top of the
 * board instead of the "ready for review" wrap-up: what ran, how it ended,
 * the end of its output, and three ways forward.
 */
export function GateBanner({
  gate,
  busy,
  onFix,
  onRetry,
  onReview,
}: {
  gate: GateInfo
  busy?: boolean
  onFix: () => void
  onRetry: () => void
  onReview: () => void
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const tail = lastLines(gate.output ?? '')
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(tail)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable: the text is on screen to select */
    }
  }
  return (
    <section
      role="alert"
      data-testid="campaign-gate-failed"
      className="flex flex-col gap-3 rounded-xl border-[0.8px] border-destructive/40 bg-destructive/5 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-medium">
            {t('settings:campaigns.board.gate.title')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.gate.body')}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {gate.command ? (
          <>
            <dt className="text-muted-foreground">
              {t('settings:campaigns.board.gate.command')}
            </dt>
            <dd
              className="min-w-0 font-mono break-all"
              data-testid="campaign-gate-command"
            >
              {gate.command}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">
          {t('settings:campaigns.board.gate.result')}
        </dt>
        <dd data-testid="campaign-gate-exit">
          {gate.timedOut
            ? t('settings:campaigns.board.gate.timedOut')
            : gate.exitCode != null
              ? t('settings:campaigns.board.gate.exit', { code: gate.exitCode })
              : t('settings:campaigns.board.gate.noExit')}
        </dd>
      </dl>
      {tail ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t('settings:campaigns.board.gate.output')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copy()}
              data-testid="campaign-gate-copy"
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied
                ? t('settings:campaigns.board.gate.copied')
                : t('settings:campaigns.board.gate.copy')}
            </Button>
          </div>
          <pre
            data-testid="campaign-gate-output"
            className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap"
          >
            <code>{tail}</code>
          </pre>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          disabled={busy}
          data-testid="campaign-gate-fix"
          onClick={onFix}
        >
          {t('settings:campaigns.board.gate.fix')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="campaign-gate-retry"
          onClick={onRetry}
        >
          {t('settings:campaigns.board.gate.retry')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          data-testid="campaign-gate-review"
          onClick={onReview}
        >
          {t('settings:campaigns.board.gate.reviewAnyway')}
        </Button>
      </div>
    </section>
  )
}
