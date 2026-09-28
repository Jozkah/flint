import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { BrowserVerifyEvidence } from '@/containers/BrowserVerifyPanel'
import type { VerifyReport } from '@/lib/browserVerify'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ChangeDestination, CompletionSummary } from '@/lib/coworkOrigins'
import {
  checkVerdict,
  deriveRunOutcome,
  summarizeVerification,
  type CheckKind,
  type CheckVerdict,
  type HeadlineCode,
  type RunOutcome,
  type RunStatus,
  type TreeKind,
  type UnresolvedItem,
  type VerificationSummary,
} from '@/lib/coworkRunOutcome'

type TFn = ReturnType<typeof useTranslation>['t']

/**
 * What the run actually did, stated by the application.
 *
 * Deliberately not part of the assistant's message. The model is the one party
 * that cannot be trusted to report on its own run: it writes the transcript
 * this is derived from, and "I updated three files" costs it nothing to say
 * whether or not it happened. So this is counted from the ledger and the tool
 * record, rendered in its own frame, and labelled as Flint's record rather than
 * the model's account.
 *
 * Each group says exactly what is known. "Flint changed" is claimed only where a
 * file tool succeeded; a check is "passed" only where Flint ran it and saw it
 * exit cleanly; anything the assistant merely said is shown as unverified.
 *
 * The outcome is derived once, by `deriveRunOutcome`, and this component only
 * renders it — so its status cannot disagree with any other surface reading
 * the same derivation.
 */
export type CoworkRunSummaryProps = {
  /** The derived outcome. When absent, one is derived from `summary` alone. */
  outcome?: RunOutcome
  /** The ledger's counted summary, for callers that have nothing else. */
  summary?: CompletionSummary | null
  /** Opens a Flint-written file. Offered only where it resolves. */
  onOpenPath?: (path: string) => void
  /** Whether `onOpenPath` can open this path. */
  canOpenPath?: (path: string) => boolean
  onReviewChanges?: () => void
  onContinue?: () => void
  /** Re-sends the last request. Offered only for stops that support it. */
  onRetry?: () => void
  /** Opens the place where a checkpoint can be restored. */
  onRestore?: () => void
  /**
   * "Verify in browser" runs for this session, newest first: evidence the
   * user asked for, shown with the run's own checks.
   */
  browserChecks?: VerifyReport[]
}

const EMPTY_SUMMARY: CompletionSummary = {
  janWrites: [],
  janWritesOverExisting: [],
  preExisting: [],
  observed: [],
  unknown: [],
  baseline: 'none',
  tree: null,
}

function statusLabel(t: TFn, status: RunStatus): string {
  switch (status) {
    case 'running':
      return t('results:status.running')
    case 'completed':
      return t('results:status.completed')
    case 'failed':
      return t('results:status.failed')
    case 'cancelled':
      return t('results:status.cancelled')
    case 'partial':
      return t('results:status.partial')
  }
}

function headlineText(t: TFn, code: HeadlineCode): string {
  switch (code) {
    case 'running':
      return t('results:headline.running')
    case 'completed-with-changes':
      return t('results:headline.completedWithChanges')
    case 'completed-no-changes':
      return t('results:headline.completedNoChanges')
    case 'completed-checks-failed':
      return t('results:headline.completedChecksFailed')
    case 'finished-incomplete':
      return t('results:headline.finishedIncomplete')
    case 'partial':
      return t('results:headline.partial')
    case 'failed':
      return t('results:headline.failed')
    case 'cancelled':
      return t('results:headline.cancelled')
  }
}

function locationText(t: TFn, kind: TreeKind): string {
  switch (kind) {
    case 'sandbox':
      return t('results:location.sandbox')
    case 'worktree':
      return t('results:location.worktree')
    case 'user-checkout':
      return t('results:location.userCheckout')
    case 'none':
      return t('results:location.none')
  }
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

/**
 * The checks, summarised in plain sentences from what was recorded: passes
 * only where a check completed with exit 0, each failure with its exit code,
 * and every check that did not finish, was not run or left no exit status.
 */
function verificationLines(
  t: TFn,
  summary: VerificationSummary
): { key: string; text: string }[] {
  const lines: { key: string; text: string }[] = []
  if (summary.allPassed) {
    lines.push({
      key: 'passed',
      text: summary.testsPassed
        ? t('results:checks.summary.allTestsPassed')
        : t('results:checks.summary.allChecksPassed'),
    })
  } else if (summary.passed > 0) {
    lines.push({
      key: 'passed',
      text: t('results:checks.summary.somePassed', {
        passed: summary.passed,
        total: summary.total,
      }),
    })
  }
  summary.failures.forEach((failure, index) =>
    lines.push({
      key: `failed-${index}`,
      text:
        failure.exitCode !== null
          ? t('results:checks.summary.failedWithCode', {
              command: failure.command,
              code: failure.exitCode,
            })
          : t('results:checks.summary.failedNoCode', {
              command: failure.command,
            }),
    })
  )
  const counted = [
    ['didNotFinish', summary.didNotFinish],
    ['notRun', summary.notRun],
    ['unknown', summary.unknown],
    ['running', summary.running],
  ] as const
  for (const [key, count] of counted) {
    if (count > 0)
      lines.push({ key, text: t(`results:checks.summary.${key}`, { count }) })
  }
  if (summary.visualNotChecked) {
    lines.push({
      key: 'visual',
      text: t('results:checks.summary.visualNotChecked'),
    })
  }
  return lines
}

function unresolvedText(t: TFn, item: UnresolvedItem): string {
  switch (item.kind) {
    case 'stop':
      switch (item.reason) {
        case 'error':
          return t('results:unresolved.stop.error')
        case 'aborted':
          return t('results:unresolved.stop.aborted')
        case 'deadline':
          return t('results:unresolved.stop.deadline')
        case 'timeout':
          return t('results:unresolved.stop.timeout')
        case 'loop':
          return t('results:unresolved.stop.loop')
        case 'steps':
          return t('results:unresolved.stop.steps')
        default:
          return t('results:unresolved.stop.tokens')
      }
    case 'refused':
      if (item.readOnly)
        return t('results:unresolved.refusedReadOnly', {
          tool: item.tool,
          target: item.target,
        })
      return t('results:unresolved.refused', {
        tool: item.tool,
        target: item.target,
      })
    case 'cancelled':
      return t('results:unresolved.cancelled', {
        tool: item.tool,
        target: item.target,
      })
    case 'failed':
      return t('results:unresolved.failed', {
        tool: item.tool,
        target: item.target,
      })
    case 'interrupted':
      return t('results:unresolved.interrupted', {
        tool: item.tool,
        target: item.target,
      })
    case 'check-failed':
      return t('results:unresolved.checkFailed', { command: item.command })
  }
}

// Semantic chips: the accent never says "passed", and a status is never told by
// colour alone -- the label is always inside the chip.
const CHIP =
  'inline-flex h-5 shrink-0 items-center rounded-md border-[0.8px] px-1.5 text-[10.5px] font-medium leading-none'

const VERDICT_TONE: Record<CheckVerdict, string> = {
  passed: 'border-success/30 bg-success-tint text-success',
  failed: 'border-destructive/30 bg-destructive-tint text-destructive',
  'did-not-finish': 'border-warning/30 bg-warning-tint text-warning',
  running: 'border-border bg-card text-secondary-foreground',
  'not-run': 'border-border bg-muted text-fg-2',
  unknown: 'border-border bg-muted text-fg-2',
}

const STATUS_TONE: Record<RunStatus, string> = {
  completed: 'border-success/30 bg-success-tint text-success',
  partial: 'border-warning/30 bg-warning-tint text-warning',
  cancelled: 'border-border bg-muted text-fg-2',
  failed: 'border-destructive/30 bg-destructive-tint text-destructive',
  running: 'border-border bg-card text-secondary-foreground',
}

export function CoworkRunSummary(props: CoworkRunSummaryProps) {
  const { t } = useTranslation()
  const outcome =
    props.outcome ??
    deriveRunOutcome({
      running: false,
      stoppedBy: 'done',
      turns: [],
      summary: props.summary ?? EMPTY_SUMMARY,
      destination: null,
      tree: props.summary?.tree ?? null,
      sessionId: null,
      checkpoints: [],
      handlers: {
        openResult: false,
        reviewChanges: false,
        continue: false,
        retry: false,
      },
    })
  const { changes, resultLocation } = outcome

  const openable = (path: string) =>
    Boolean(props.onOpenPath) && (props.canOpenPath?.(path) ?? true)

  const pathRow = (path: string, open: boolean) => (
    <li
      key={path}
      className="flex min-w-0 items-center gap-2 border-b border-dashed border-border py-1.5 font-mono text-xs text-fg-2 last:border-b-0"
    >
      <span className="min-w-0 flex-1 break-all">{path}</span>
      {open && openable(path) ? (
        <Button
          variant="link"
          size="sm"
          className="h-6 shrink-0 px-1 font-sans text-[12.5px] text-secondary-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:h-11"
          aria-label={t('results:location.open', { path })}
          onClick={() => props.onOpenPath?.(path)}
        >
          {t('results:actions.openResult')}
        </Button>
      ) : null}
    </li>
  )

  /**
   * One group of this session's own writes: the first few, with "Show all"
   * for the rest.
   */
  const group = (label: string, paths: readonly string[], open = false) =>
    paths.length === 0 ? null : (
      <PathGroup
        key={label}
        label={label}
        paths={paths}
        row={(path) => pathRow(path, open)}
      />
    )

  // Only this session's own writes are listed. Files that were already
  // changed, or changed by something else while it ran, are not its work: a
  // checkout with thousands of uncommitted files turned this card into a
  // wall of paths that said nothing about the run.
  const nothingFound =
    changes.janAuthored.length === 0 &&
    changes.janWritesOverExisting.length === 0

  const verification = summarizeVerification(outcome)
  const firstOpenable = resultLocation.paths.find(openable)
  const interrupted =
    outcome.status === 'partial' ||
    outcome.status === 'cancelled' ||
    outcome.status === 'failed'

  const actionButton = (
    key: string,
    label: string,
    onClick: (() => void) | undefined
  ) =>
    onClick ? (
      <Button
        key={key}
        // Continuing is the way forward; the rest are side roads.
        variant={key === 'continue' ? 'default' : 'surface'}
        size="sm"
        className="pointer-coarse:h-11"
        onClick={onClick}
      >
        {label}
      </Button>
    ) : null

  const actions = outcome.nextActions
    .map((action) => {
      switch (action) {
        case 'open-result':
          return firstOpenable
            ? actionButton(action, t('results:actions.openResult'), () =>
                props.onOpenPath?.(firstOpenable)
              )
            : null
        case 'review-changes':
          return actionButton(
            action,
            t('results:actions.reviewChanges'),
            props.onReviewChanges
          )
        case 'retry':
          return actionButton(action, t('results:actions.retry'), props.onRetry)
        case 'restore':
          return actionButton(
            action,
            t('results:actions.restore'),
            props.onRestore
          )
        case 'continue':
          return actionButton(
            action,
            t('results:actions.continue'),
            props.onContinue
          )
      }
    })
    .filter(Boolean)
  const offersRetry =
    outcome.nextActions.includes('retry') && Boolean(props.onRetry)

  const heading = (text: string) => (
    <h4 className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
      {text}
    </h4>
  )

  return (
    <section
      // Labelled, so it is reachable as its own region rather than read as a
      // continuation of the message above it.
      aria-label={t('common:coworkOrigins.title')}
      data-testid="cowork-run-summary"
      data-status={outcome.status}
      data-session-id={outcome.source.sessionId ?? undefined}
      data-run-id={outcome.source.runId ?? undefined}
      className="my-2 rounded-xl border-[0.8px] border-border bg-card text-[13px] motion-safe:animate-rise-in"
    >
      {/* Collapsed by default after a clean finish: Flint's record of a run is
          worth keeping, but it was opening in full under every single
          message. A run that did not finish opens, because what it left
          behind is the thing to read. */}
      <details open={interrupted} className="group">
        <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13.5px] text-foreground outline-none transition-colors hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 truncate font-semibold">
            {t('common:coworkOrigins.title')}
          </span>
          <span
            data-testid="cowork-run-status"
            className={`${CHIP} ${STATUS_TONE[outcome.status]}`}
          >
            {statusLabel(t, outcome.status)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {t('common:coworkOrigins.subtitle')}
          </span>
        </summary>
        <h3 className="sr-only">{t('common:coworkOrigins.title')}</h3>

        <div className="flex flex-col [&>div]:gap-1.5 [&>div]:border-t [&>div]:border-dashed [&>div]:border-border [&>div]:px-3 [&>div]:py-2.5">
          <div className="flex flex-col gap-1">
            {heading(t('results:sections.happened'))}
            <p className="text-foreground">
              {headlineText(t, outcome.headline)}
            </p>
            {interrupted && resultLocation.paths.length > 0 ? (
              <p className="text-fg-2">{t('results:kept')}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            {heading(t('results:sections.where'))}
            {resultLocation.treeKind === 'worktree' && resultLocation.tree ? (
              // Named, because "in the worktree" is true of a specific one and
              // the reader has to be able to go and look at it.
              <p className="break-all font-mono text-xs text-fg-2">
                {t('common:coworkOrigins.inTree', {
                  tree: resultLocation.tree,
                })}
              </p>
            ) : null}
            {resultLocation.destination ? (
              <p className="text-fg-2">
                {locationText(t, resultLocation.treeKind)}
              </p>
            ) : null}
            {nothingFound ? (
              <p className="text-fg-2">
                {t('common:coworkOrigins.nothing')}
              </p>
            ) : (
              <>
                {changes.janAuthored.map((written) =>
                  group(
                    t(
                      `common:coworkOrigins.janWrites.${written.destination satisfies ChangeDestination}`
                    ),
                    written.paths,
                    true
                  )
                )}
                {group(
                  t('common:coworkOrigins.overExisting'),
                  changes.janWritesOverExisting
                )}
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {t(`common:coworkOrigins.baseline.${changes.baseline}`)}
            </p>
          </div>

          <div className="flex flex-col gap-1" data-testid="cowork-run-checks">
            {heading(t('results:sections.checked'))}
            {outcome.checks.length === 0 ? (
              <p className="text-fg-2">{t('results:checks.none')}</p>
            ) : (
              <>
                <ul className="flex flex-col">
                  {outcome.checks.map((check, index) => (
                    <li
                      key={`${check.callId ?? check.command}-${index}`}
                      className="flex min-w-0 flex-wrap items-center gap-2.5 py-1 text-[12.5px]"
                    >
                      <span
                        className={`${CHIP} ${VERDICT_TONE[checkVerdict(check)]}`}
                      >
                        {verdictLabel(t, checkVerdict(check))}
                      </span>
                      <span className="shrink-0 text-fg-2">
                        {kindLabel(t, check.kind)}
                      </span>
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
                            <li key={limit}>
                              {t(`results:checks.limitation.${limit}`)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <ul
                  className="flex flex-col gap-0.5 text-xs text-muted-foreground"
                  data-testid="cowork-verification-summary"
                >
                  {verificationLines(t, verification).map((line) => (
                    <li key={line.key} className="break-words">
                      {line.text}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {verification.otherCommands > 0 ? (
              <p
                className="text-muted-foreground"
                data-testid="cowork-other-commands"
              >
                {t('results:checks.otherCommands', {
                  count: verification.otherCommands,
                })}
              </p>
            ) : null}
            {props.browserChecks && props.browserChecks.length > 0 ? (
              <div className="flex flex-col gap-1" data-testid="cowork-browser-checks">
                <span className="text-fg-2">{t('common:browserVerify.inSummary')}</span>
                <BrowserVerifyEvidence report={props.browserChecks[0]} />
              </div>
            ) : null}
            {outcome.claims.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-fg-2">
                  {t('results:checks.claimsTitle')}
                </span>
                <ul className="flex flex-col gap-0.5">
                  {outcome.claims.map((claim) => (
                    <li key={claim.text} className="italic text-fg-2">
                      “{claim.text}”
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {outcome.unresolved.length > 0 ? (
            <div className="flex flex-col gap-1 shadow-[inset_3px_0_0_var(--warning)]">
              {heading(t('results:sections.unresolved'))}
              <ul className="flex list-disc flex-col gap-0.5 pl-4">
                {outcome.unresolved.map((item, index) => (
                  <li key={index} className="break-words text-foreground">
                    {unresolvedText(t, item)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {actions.length > 0 ? (
            <div className="flex flex-col gap-1">
              {heading(t('results:sections.next'))}
              <div className="flex flex-wrap gap-1.5">{actions}</div>
              {offersRetry ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('results:actions.retryNote')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  )
}

const OWN_SHOWN = 10

function PathGroup(props: {
  label: string
  paths: readonly string[]
  row: (path: string) => ReactNode
}) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const { label, paths, row } = props
  const count = paths.length
  const shown = all ? paths : paths.slice(0, OWN_SHOWN)
  return (
    <div className="flex flex-col gap-1" data-testid="cowork-path-group">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ul className="flex flex-col">{shown.map(row)}</ul>
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
