import { useEffect, useRef, useState } from 'react'
import { Eye, FileDiff, X } from 'lucide-react'
import { BarRow } from '@/components/ui/bar-row'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { readyBarSignature, useCoworkDisplay } from '@/hooks/useCoworkDisplay'
import {
  CoworkApplyAllDialog,
  type SandboxApplyActions,
} from '@/containers/CoworkApplyAllDialog'
import {
  autoApplicable,
  planApplyAll,
  runApplyAll,
  toastApplyAll,
  type ApplyAllEntry,
} from '@/lib/coworkApplyAll'

/**
 * "N files ready for review", at the end of the conversation once a run has
 * stopped, with the way to the Changes panel beside it.
 *
 * Counts only what the Changes rail already counts for this session, so it can
 * never disagree with the panel it opens. Its × hides it for this session until
 * the changes differ; the "Show the files-ready bar" setting hides it
 * everywhere. Either way the Changes rail and the composer's ± counter still
 * lead to the same list.
 *
 * Also where a Review only run's end is acted on, as the "When a Review only
 * run finishes" setting says: nothing, the Apply all confirmation, or applying
 * every new file straight away (a conflict still opens the confirmation).
 */
export function CoworkReviewReady({
  fileCount,
  additions,
  deletions,
  onReview,
  sessionId,
  running = false,
  sandboxPaths = [],
  applyActions,
}: {
  fileCount: number
  additions: number
  deletions: number
  onReview: () => void
  sessionId?: string
  running?: boolean
  /** The session's changed files, for Apply all when a run finishes. */
  sandboxPaths?: readonly string[]
  applyActions?: SandboxApplyActions
}) {
  const { t } = useTranslation()
  const showBar = useCoworkDisplay((s) => s.showFilesReadyBar)
  const hiddenAt = useCoworkDisplay((s) =>
    sessionId ? s.hiddenReadyBars[sessionId] : undefined
  )
  const hideReadyBar = useCoworkDisplay((s) => s.hideReadyBar)
  const signature = readyBarSignature(fileCount, additions, deletions)

  const [dialog, setDialog] = useState<{ initial?: ApplyAllEntry[] } | null>(
    null
  )
  const wasRunning = useRef({ sessionId, running })
  const latest = useRef({ sandboxPaths, applyActions })
  latest.current = { sandboxPaths, applyActions }

  // A run that just finished in this session (not a switch to another one).
  useEffect(() => {
    const before = wasRunning.current
    wasRunning.current = { sessionId, running }
    if (before.sessionId !== sessionId || !before.running || running) return
    const { sandboxPaths: paths, applyActions: actions } = latest.current
    const mode = useCoworkDisplay.getState().reviewOnlyFinish
    if (mode === 'keep' || !actions) return
    if (!paths.some((p) => actions.planFor(p))) return
    if (mode === 'ask') {
      setDialog({})
      return
    }
    void (async () => {
      const entries = await planApplyAll(paths, actions.planFor, actions.probe)
      const { apply, conflicts } = autoApplicable(entries)
      if (apply.length > 0) {
        toastApplyAll(await runApplyAll(apply, actions.apply), t)
      }
      if (conflicts.length > 0) setDialog({ initial: conflicts })
    })()
  }, [running, sessionId, t])

  const applyDialog =
    applyActions && dialog ? (
      <CoworkApplyAllDialog
        open
        onOpenChange={(open) => !open && setDialog(null)}
        paths={sandboxPaths}
        actions={applyActions}
        initial={dialog.initial}
      />
    ) : null

  if (fileCount <= 0 || !showBar || hiddenAt === signature) return applyDialog
  return (
    <>
      {applyDialog}
      <section
        aria-label={t('common:coworkReview.ready', { count: fileCount })}
        data-testid="cowork-review-ready"
        className="mb-1.5 min-w-0 motion-safe:animate-rise-in"
      >
        <BarRow
          className="bg-muted shadow-[inset_0_0_0_0.8px_var(--border)]"
          icon={<FileDiff className="size-4 shrink-0 text-fg-2" aria-hidden />}
          lead={t('common:coworkReview.ready', { count: fileCount })}
          leadClassName="font-semibold text-foreground"
          meta={
            <span className="shrink-0 font-mono text-xs tabular-nums">
              <span className="text-diff-add">+{additions}</span>{' '}
              <span className="text-diff-del">−{deletions}</span>
            </span>
          }
          actions={[
            {
              id: 'review',
              label: t('common:coworkReview.open'),
              onSelect: onReview,
              testId: 'cowork-review-ready-open',
              icon: <Eye className="size-3.5" />,
              iconOnlyCollapsed: true,
              variant: 'outline',
              floor: 'icon',
            },
          ]}
          trailingAction={
            sessionId
              ? {
                  id: 'hide',
                  label: t('common:coworkReview.hide'),
                  icon: <X className="size-3.5" />,
                  onSelect: () => hideReadyBar(sessionId, signature),
                  testId: 'cowork-review-ready-hide',
                }
              : undefined
          }
          trailing={
            sessionId ? (
              <button
                type="button"
                onClick={() => hideReadyBar(sessionId, signature)}
                aria-label={t('common:coworkReview.hide')}
                title={t('common:coworkReview.hideHint')}
                data-testid="cowork-review-ready-hide"
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover-btn hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:size-11"
              >
                <X className="size-3.5" />
              </button>
            ) : null
          }
        />
      </section>
    </>
  )
}

export default CoworkReviewReady
