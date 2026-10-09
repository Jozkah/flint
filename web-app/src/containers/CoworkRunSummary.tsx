import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { BrowserVerifyEvidence } from '@/containers/BrowserVerifyPanel'
import type { VerifyReport } from '@/lib/browserVerify'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ChangeDestination, CompletionSummary } from '@/lib/coworkOrigins'
import { unresolvedForSummary } from '@/lib/coworkUnresolvedPresentation'
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
  const visibleUnresolved = unresolvedForSummary(outcome)

  const openable = (path: string) =>
    Boolean(props.onOpenPath) && (props.canOpenPath?.(path) ?? true)

  const pathRow = (path: string, open: boolean) => (
    <li
      key={path}
      className="flex min-w-0 items-center gap-2 border-b border-dashed border-border py-1.5 font-mono text-xs text-fg-2 last:border-b-0"
    >
      {open && openable(path) ? (
        <button
          type="button"
          className="min-w-0 flex-1 break-all text-left text-acc-text underline decoration-dotted underline-offset-2 hover:text-foreground"
          onClick={() => props.onOpenPath?.(path)}
        >
          {path}
        </button>
      ) : (
        <span className="min-w-0 flex-1 break-all">{path}</span>
      )}
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

  const checkRow = (check: (typeof outcome.checks)[number], index: number) => (
    <li
      key={`${check.callId ?? check.command}-${index}`}
      className="flex min-w-0 flex-wrap items-center gap-2.5 py-1 text-[12.5px]"
    >
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
  // A check that passed is evidence; one that did not is a finding. Only the
  // finding stays up front, the passes sit under Details.
  const attentionChecks = outcome.checks.filter(
    (c) => checkVerdict(c) !== 'passed'
  )
  const passedChecks = outcome.checks.filter(
    (c) => checkVerdict(c) === 'passed'
  )

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
      data-quiet={interrupted ? undefined : ''}
      className={
        interrupted
          ? 'my-2 rounded-xl border-[0.8px] border-border bg-card text-[13px] motion-safe:animate-rise-in'
          : // A clean finish is one quiet line, like the steps row, until
            // opened: under every run a full card grew tiresome.
            'my-1 rounded-xl text-[13px] open:border-[0.8px] open:border-border open:bg-card has-[details[open]]:border-[0.8px] has-[details[open]]:border-border has-[details[open]]:bg-card'
      }
    >
      {/* Collapsed by default after a clean finish: Flint's record of a run is
          worth keeping, but it was opening in full under every single
          message. A run that did not finish opens, because what it left
          behind is the thing to read. */}
      <details open={interrupted} className="group">
        <summary
          className={
            interrupted
              ? 'flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13.5px] text-foreground outline-none transition-colors hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden'
              : 'flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 group-open:px-3 group-open:py-2.5 group-open:text-[13.5px] group-open:text-foreground pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden'
          }
        >
          {!interrupted && (
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90"
            />
          )}
          <span
            className={cn(
              'min-w-0 truncate',
              interrupted ? 'font-semibold' : 'font-medium group-open:font-semibold'
            )}
            // Where this record comes from, on hover rather than on the row.
            title={t('common:coworkOrigins.subtitle')}
          >
            {t('common:coworkOrigins.title')}
          </span>
          {interrupted ? (
            <span
              data-testid="cowork-run-status"
              className={`${CHIP} ${STATUS_TONE[outcome.status]}`}
            >
              {statusLabel(t, outcome.status)}
            </span>
          ) : (
            // What happened in numbers rather than a status the run already
            // showed: the files it wrote and the checks it ran.
            <span data-testid="cowork-run-counts" className="min-w-0 truncate">
              {[
                resultLocation.paths.length > 0
                  ? t('common:coworkOrigins.files', { count: resultLocation.paths.length })
                  : null,
                outcome.checks.length > 0
                  ? t('common:coworkOrigins.checks', { count: outcome.checks.length })
                  : null,
              ]
                .filter(Boolean)
                .map((part) => ` · ${part}`)
                .join('')}
              <span data-testid="cowork-run-status" className="sr-only">
                {statusLabel(t, outcome.status)}
              </span>
            </span>
          )}
          <span className="sr-only">{t('common:coworkOrigins.subtitle')}</span>
        </summary>
        <h3 className="sr-only">{t('common:coworkOrigins.title')}</h3>

        <div className="flex flex-col [&>div]:gap-1.5 [&>div]:border-t [&>div]:border-dashed [&>div]:border-border [&>div]:px-3 [&>div]:py-2.5">
          {/* One checkpoint: what changed, what was checked, what needs
              attention and the way to act on it. Everything else is under
              Details, one click away. */}
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
                  changes.janWritesOverExisting,
                  true
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1" data-testid="cowork-run-checks">
            {heading(t('results:sections.checked'))}
            {outcome.checks.length === 0 ? (
              <p className="text-fg-2">{t('results:checks.none')}</p>
            ) : (
              <>
                {/* Anything that did not pass stays in view. */}
                {attentionChecks.length > 0 ? (
                  <ul className="flex flex-col">
                    {attentionChecks.map(checkRow)}
                  </ul>
                ) : null}
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
          </div>

          {visibleUnresolved.length > 0 ? (
            <div className="flex flex-col gap-1 shadow-[inset_3px_0_0_var(--warning)]">
              {heading(t('results:sections.unresolved'))}
              <ul className="flex list-disc flex-col gap-0.5 pl-4">
                {visibleUnresolved.map((item, index) => (
                  <li key={index} className="break-words text-foreground">
                    {unresolvedText(t, item)}
                    {item.kind === 'stop' && item.message ? (
                      <div className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                        {item.message}
                      </div>
                    ) : null}
                    {item.kind === 'failed' && item.detail ? (
                      <div className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                        {item.detail}
                      </div>
                    ) : null}
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

          <div className="flex flex-col">
            <details data-testid="cowork-run-details" className="group/details">
              <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-3.5 shrink-0 transition-transform duration-200 group-open/details:rotate-90"
                />
                {t('results:sections.details')}
              </summary>
              <div className="flex flex-col gap-2 pt-1.5">
                {resultLocation.treeKind === 'worktree' && resultLocation.tree ? (
                  // Named, because "in the worktree" is true of a specific one
                  // and the reader has to be able to go and look at it.
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
                <p className="text-xs text-muted-foreground">
                  {t(`common:coworkOrigins.baseline.${changes.baseline}`)}
                </p>
                {passedChecks.length > 0 ? (
                  <ul className="flex flex-col">{passedChecks.map(checkRow)}</ul>
                ) : null}
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
            </details>
          </div>
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
