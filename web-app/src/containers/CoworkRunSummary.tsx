import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ChangeDestination, CompletionSummary } from '@/lib/coworkOrigins'
import {
  deriveRunOutcome,
  verifiedChecks,
  type CheckKind,
  type CheckOutcome,
  type HeadlineCode,
  type RunOutcome,
  type RunStatus,
  type TreeKind,
  type UnresolvedItem,
} from '@/lib/coworkRunOutcome'

type TFn = ReturnType<typeof useTranslation>['t']

/**
 * What the run actually did, stated by the application.
 *
 * Deliberately not part of the assistant's message. The model is the one party
 * that cannot be trusted to report on its own run: it writes the transcript
 * this is derived from, and "I updated three files" costs it nothing to say
 * whether or not it happened. So this is counted from the ledger and the tool
 * record, rendered in its own frame, and labelled as Jan's record rather than
 * the model's account.
 *
 * Each group says exactly what is known. "Jan changed" is claimed only where a
 * file tool succeeded; a check is "passed" only where Jan ran it and saw it
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
  /** Opens a Jan-written file. Offered only where it resolves. */
  onOpenPath?: (path: string) => void
  /** Whether `onOpenPath` can open this path. */
  canOpenPath?: (path: string) => boolean
  onReviewChanges?: () => void
  onContinue?: () => void
  /** Re-sends the last request. Offered only for stops that support it. */
  onRetry?: () => void
  /** Opens the place where a checkpoint can be restored. */
  onRestore?: () => void
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

function outcomeLabel(t: TFn, outcome: CheckOutcome): string {
  switch (outcome) {
    case 'passed':
      return t('results:checks.outcome.passed')
    case 'failed':
      return t('results:checks.outcome.failed')
    case 'not-run':
      return t('results:checks.outcome.notRun')
    case 'unknown':
      return t('results:checks.outcome.unknown')
  }
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

const OUTCOME_TONE: Record<CheckOutcome, string> = {
  passed: 'bg-primary/10 text-primary',
  failed: 'bg-destructive/10 text-destructive',
  'not-run': 'bg-main-view-fg/5 text-main-view-fg/70',
  unknown: 'bg-main-view-fg/5 text-main-view-fg/70',
}

const STATUS_TONE: Record<RunStatus, string> = {
  completed: 'bg-primary/10 text-primary',
  partial: 'bg-main-view-fg/10 text-main-view-fg',
  cancelled: 'bg-main-view-fg/5 text-main-view-fg/70',
  failed: 'bg-destructive/10 text-destructive',
  running: 'bg-main-view-fg/5 text-main-view-fg/70',
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

  const group = (label: string, paths: readonly string[], open = false) =>
    paths.length === 0 ? null : (
      <div key={label} className="flex flex-col gap-0.5">
        <span className="text-main-view-fg/70">{label}</span>
        <ul className="flex flex-col gap-0.5">
          {paths.map((path) => (
            <li
              key={path}
              className="flex min-w-0 items-center gap-2 font-mono text-main-view-fg/90"
            >
              <span className="min-w-0 break-all">{path}</span>
              {open && openable(path) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 font-sans"
                  aria-label={t('results:location.open', { path })}
                  onClick={() => props.onOpenPath?.(path)}
                >
                  {t('results:actions.openResult')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    )

  const nothingFound =
    changes.janAuthored.length === 0 &&
    changes.preExisting.length === 0 &&
    changes.observed.length === 0 &&
    changes.unknown.length === 0

  const verdicts = verifiedChecks(outcome)
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
        variant="outline"
        size="sm"
        className="h-7"
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
    <h4 className="font-medium text-main-view-fg/80">{text}</h4>
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
      className="my-3 rounded-md border border-main-view-fg/10 bg-main-view-fg/[0.03] p-3 text-xs"
    >
      {/* Collapsed by default after a clean finish: Jan's record of a run is
          worth keeping, but it was opening in full under every single
          message. A run that did not finish opens, because what it left
          behind is the thing to read. */}
      <details open={interrupted}>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm font-medium text-main-view-fg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span>{t('common:coworkOrigins.title')}</span>
          <span
            data-testid="cowork-run-status"
            className={`rounded px-1.5 py-0.5 font-normal ${STATUS_TONE[outcome.status]}`}
          >
            {statusLabel(t, outcome.status)}
          </span>
        </summary>
        <header className="mt-2 mb-2 flex flex-col gap-0.5">
          <h3 className="sr-only">{t('common:coworkOrigins.title')}</h3>
          <p className="text-main-view-fg/60">
            {t('common:coworkOrigins.subtitle')}
          </p>
        </header>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            {heading(t('results:sections.happened'))}
            <p className="text-main-view-fg/90">
              {headlineText(t, outcome.headline)}
            </p>
            {interrupted && resultLocation.paths.length > 0 ? (
              <p className="text-main-view-fg/70">{t('results:kept')}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            {heading(t('results:sections.where'))}
            {resultLocation.treeKind === 'worktree' && resultLocation.tree ? (
              // Named, because "in the worktree" is true of a specific one and
              // the reader has to be able to go and look at it.
              <p className="break-all font-mono text-main-view-fg/70">
                {t('common:coworkOrigins.inTree', {
                  tree: resultLocation.tree,
                })}
              </p>
            ) : null}
            {resultLocation.destination ? (
              <p className="text-main-view-fg/70">
                {locationText(t, resultLocation.treeKind)}
              </p>
            ) : null}
            {nothingFound ? (
              <p className="text-main-view-fg/70">
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
                {group(
                  t('common:coworkOrigins.preExisting'),
                  changes.preExisting
                )}
                {group(t('common:coworkOrigins.observed'), changes.observed)}
                {group(t('common:coworkOrigins.unknown'), changes.unknown)}
              </>
            )}
            <p className="text-main-view-fg/60">
              {t(`common:coworkOrigins.baseline.${changes.baseline}`)}
            </p>
          </div>

          <div className="flex flex-col gap-1" data-testid="cowork-run-checks">
            {heading(t('results:sections.checked'))}
            {outcome.checks.length === 0 ? (
              <p className="text-main-view-fg/70">{t('results:checks.none')}</p>
            ) : (
              <>
                <ul className="flex flex-col gap-1">
                  {outcome.checks.map((check, index) => (
                    <li
                      key={`${check.callId ?? check.command}-${index}`}
                      className="flex min-w-0 flex-wrap items-center gap-2"
                    >
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 ${OUTCOME_TONE[check.outcome]}`}
                      >
                        {outcomeLabel(t, check.outcome)}
                      </span>
                      <span className="shrink-0 text-main-view-fg/70">
                        {kindLabel(t, check.kind)}
                      </span>
                      <code className="min-w-0 break-all font-mono text-main-view-fg/90">
                        {check.command}
                      </code>
                      {check.exitCode !== null ? (
                        <span className="shrink-0 font-mono text-main-view-fg/60">
                          {t('results:checks.exit', { code: check.exitCode })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-main-view-fg/60">
                  {verdicts.length === 0
                    ? t('results:checks.noneVerified')
                    : t('results:checks.observedNote')}
                </p>
              </>
            )}
            {outcome.claims.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-main-view-fg/70">
                  {t('results:checks.claimsTitle')}
                </span>
                <ul className="flex flex-col gap-0.5">
                  {outcome.claims.map((claim) => (
                    <li
                      key={claim.text}
                      className="italic text-main-view-fg/70"
                    >
                      “{claim.text}”
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {outcome.unresolved.length > 0 ? (
            <div className="flex flex-col gap-1">
              {heading(t('results:sections.unresolved'))}
              <ul className="flex list-disc flex-col gap-0.5 pl-4">
                {outcome.unresolved.map((item, index) => (
                  <li key={index} className="break-words text-main-view-fg/90">
                    {unresolvedText(t, item)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {actions.length > 0 ? (
            <div className="flex flex-col gap-1">
              {heading(t('results:sections.next'))}
              <div className="flex flex-wrap gap-2">{actions}</div>
              {offersRetry ? (
                <p className="text-main-view-fg/60">
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
