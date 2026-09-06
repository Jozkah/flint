import { useTranslation } from '@/i18n/react-i18next-compat'
import { shapingNotice, shapingWorthReporting } from '@/lib/coworkContext'
import type { ContextShaping } from '@/lib/coworkReadiness'
import {
  summaryIsEmpty,
  type ChangeDestination,
  type CompletionSummary,
} from '@/lib/coworkOrigins'

/**
 * What the run actually changed, stated by the application.
 *
 * Deliberately not part of the assistant's message. The model is the one party
 * that cannot be trusted to report on its own run: it writes the transcript
 * this is derived from, and "I updated three files" costs it nothing to say
 * whether or not it happened. So this is counted from the ledger, rendered in
 * its own frame, and labelled as Jan's record rather than the model's account.
 *
 * Each group says exactly what is known. "Jan changed" is claimed only where a
 * file tool succeeded; everything else is reported as found, not as done.
 */
export function CoworkRunSummary({
  summary,
  shaping,
}: {
  summary: CompletionSummary
  /**
   * What the context manager took out of the run's payload, when it took
   * anything.
   *
   * Belongs in the completion summary for the same reason the file lists do:
   * it is a fact about the run that the model has no incentive to mention and
   * every reason to be unaware of. A run whose earlier turns were dropped
   * produced its answer from less than the conversation on screen, and only
   * the application knows that.
   */
  shaping?: ContextShaping
}) {
  const { t } = useTranslation()
  const shapingLine =
    shaping && shapingWorthReporting(shaping) ? shapingNotice(shaping) : null

  const group = (label: string, paths: readonly string[]) =>
    paths.length === 0 ? null : (
      <div key={label} className="flex flex-col gap-0.5">
        <span className="text-main-view-fg/70">{label}</span>
        <ul className="flex flex-col gap-0.5">
          {paths.map((path) => (
            <li key={path} className="font-mono text-main-view-fg/90">
              {path}
            </li>
          ))}
        </ul>
      </div>
    )

  return (
    <section
      // Labelled, so it is reachable as its own region rather than read as a
      // continuation of the message above it.
      aria-label={t('common:coworkOrigins.title')}
      data-testid="cowork-run-summary"
      className="my-3 rounded-md border border-main-view-fg/10 bg-main-view-fg/[0.03] p-3 text-xs"
    >
      <header className="mb-2 flex flex-col gap-0.5">
        <h3 className="font-medium text-main-view-fg">
          {t('common:coworkOrigins.title')}
        </h3>
        <p className="text-main-view-fg/60">
          {t('common:coworkOrigins.subtitle')}
        </p>
      </header>

      {summary.tree ? (
        // Named, because "in the worktree" is true of a specific one and the
        // reader has to be able to go and look at it.
        <p className="mb-2 break-all font-mono text-main-view-fg/70">
          {t('common:coworkOrigins.inTree', { tree: summary.tree })}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {summaryIsEmpty(summary) ? (
          <p className="text-main-view-fg/70">
            {t('common:coworkOrigins.nothing')}
          </p>
        ) : (
          <>
            {summary.janWrites.map((written) =>
              group(
                t(
                  `common:coworkOrigins.janWrites.${written.destination satisfies ChangeDestination}`
                ),
                written.paths
              )
            )}
            {group(
              t('common:coworkOrigins.overExisting'),
              summary.janWritesOverExisting
            )}
            {group(t('common:coworkOrigins.preExisting'), summary.preExisting)}
            {group(t('common:coworkOrigins.observed'), summary.observed)}
            {group(t('common:coworkOrigins.unknown'), summary.unknown)}
          </>
        )}
        {shapingLine ? (
          <p className="text-main-view-fg/60">
            {t(shapingLine.key, shapingLine.params)}
          </p>
        ) : null}
        <p className="text-main-view-fg/60">
          {t(`common:coworkOrigins.baseline.${summary.baseline}`)}
        </p>
      </div>
    </section>
  )
}
