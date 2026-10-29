import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  checkVerdict,
  type CheckKind,
  type CheckVerdict,
  type RunOutcome,
  type RunStatus,
} from '@/lib/coworkRunOutcome'

type TFn = ReturnType<typeof useTranslation>['t']
type Check = RunOutcome['checks'][number]

// Semantic chips: the accent never says "passed", and a status is never told by
// colour alone -- the label is always inside the chip.
export const CHIP =
  'inline-flex h-5 shrink-0 items-center rounded-md border-[0.8px] px-1.5 text-[length:calc(var(--ui-font-base)*0.65625)] font-medium leading-none'

const VERDICT_TONE: Record<CheckVerdict, string> = {
  passed: 'border-success/30 bg-success-tint text-success',
  failed: 'border-destructive/30 bg-destructive-tint text-destructive',
  'did-not-finish': 'border-warning/30 bg-warning-tint text-warning',
  running: 'border-border bg-card text-secondary-foreground',
  'not-run': 'border-border bg-muted text-fg-2',
  unknown: 'border-border bg-muted text-fg-2',
}

export const STATUS_TONE: Record<RunStatus, string> = {
  completed: 'border-success/30 bg-success-tint text-success',
  partial: 'border-warning/30 bg-warning-tint text-warning',
  cancelled: 'border-border bg-muted text-fg-2',
  failed: 'border-destructive/30 bg-destructive-tint text-destructive',
  running: 'border-border bg-card text-secondary-foreground',
}

function kindLabel(t: TFn, kind: CheckKind): string {
  switch (kind) {
    case 'test':
      return t('results:checks.kind.test')
    case 'build':
      return t('results:checks.kind.build')
    case 'lint':
      return t('results:checks.kind.lint')
    case 'command':
      return t('results:checks.kind.command')
  }
}

function verdictLabel(t: TFn, verdict: CheckVerdict): string {
  switch (verdict) {
    case 'passed':
      return t('results:checks.outcome.passed')
    case 'failed':
      return t('results:checks.outcome.failed')
    case 'did-not-finish':
      return t('results:checks.outcome.didNotFinish')
    case 'running':
      return t('results:checks.outcome.running')
    case 'not-run':
      return t('results:checks.outcome.notRun')
    case 'unknown':
      return t('results:checks.outcome.unknown')
  }
}

export function SectionHeading({ text }: { text: string }) {
  return (
    <h4 className="text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
      {text}
    </h4>
  )
}

/** One check: its verdict, kind, command, exit code and limitations. */
export function CheckRow({ check }: { check: Check }) {
  const { t } = useTranslation()
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2.5 py-1 text-[length:calc(var(--ui-font-base)*0.78125)]">
      <span className={`${CHIP} ${VERDICT_TONE[checkVerdict(check)]}`}>
        {verdictLabel(t, checkVerdict(check))}
      </span>
      <span className="shrink-0 text-fg-2">{kindLabel(t, check.kind)}</span>
      <code className="min-w-0 break-all font-mono text-xs text-foreground">
        {check.command}
      </code>
      {check.exitCode !== null ? (
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
          {t('results:checks.exit', { code: check.exitCode })}
        </span>
      ) : null}
      <span className="shrink-0 text-muted-foreground">
        {t(`results:checks.completion.${check.completion}`)}
      </span>
      {check.limitations.length > 0 ? (
        <ul
          className="basis-full pl-4 text-muted-foreground"
          data-testid="cowork-check-limitations"
        >
          {check.limitations.map((limit) => (
            <li key={limit}>{t(`results:checks.limitation.${limit}`)}</li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function CheckList({
  checks,
  className,
}: {
  checks: readonly Check[]
  className?: string
}) {
  return (
    <ul className={className}>
      {checks.map((check, index) => (
        <CheckRow key={`${check.callId ?? check.command}-${index}`} check={check} />
      ))}
    </ul>
  )
}

/** One written path, with an Open link when it can be opened. */
function PathRow({
  path,
  onOpen,
}: {
  path: string
  onOpen: ((path: string) => void) | null
}) {
  const { t } = useTranslation()
  return (
    <li className="flex min-w-0 items-center gap-2 border-b border-dashed border-border py-1.5 font-mono text-xs text-fg-2 last:border-b-0">
      {onOpen ? (
        <button
          type="button"
          className="min-w-0 flex-1 break-all text-left text-acc-text underline decoration-dotted underline-offset-2 hover:text-foreground"
          onClick={() => onOpen(path)}
        >
          {path}
        </button>
      ) : (
        <span className="min-w-0 flex-1 break-all">{path}</span>
      )}
      {onOpen ? (
        <Button
          variant="link"
          size="sm"
          className="h-6 shrink-0 px-1 font-sans text-[length:calc(var(--ui-font-base)*0.78125)] text-secondary-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:h-11"
          aria-label={t('results:location.open', { path })}
          onClick={() => onOpen(path)}
        >
          {t('results:actions.openResult')}
        </Button>
      ) : null}
    </li>
  )
}

const OWN_SHOWN = 10

/**
 * One group of this session's own writes: the first few, with "Show all"
 * for the rest.
 */
export function PathGroup({
  label,
  paths,
  openable,
  onOpenPath,
}: {
  label: string
  paths: readonly string[]
  openable: (path: string) => boolean
  onOpenPath?: (path: string) => void
}) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const count = paths.length
  const shown = all ? paths : paths.slice(0, OWN_SHOWN)
  return (
    <div className="flex flex-col gap-1" data-testid="cowork-path-group">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ul className="flex flex-col">
        {shown.map((path) => (
          <PathRow
            key={path}
            path={path}
            onOpen={
              openable(path) ? (p: string) => onOpenPath?.(p) : null
            }
          />
        ))}
      </ul>
      {count > shown.length ? (
        <button
          type="button"
          className="self-start text-xs text-secondary-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setAll(true)}
        >
          {t('common:coworkOrigins.showAll', {
            count,
            formattedCount: count.toLocaleString(),
          })}
        </button>
      ) : null}
    </div>
  )
}
