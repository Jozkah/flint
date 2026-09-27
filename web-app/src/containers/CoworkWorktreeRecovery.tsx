import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { describePending, shortPath } from '@/lib/coworkWorktrees'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'

/**
 * Work a previous run left in a checkout nothing points at any more.
 *
 * Flint does not persist which worktree belonged to which session — a record
 * restored from disk would claim a checkout exists without anyone having
 * looked. So after a crash the work is still there and the session has
 * forgotten it. This is how it comes back.
 *
 * Two rules the component keeps.
 *
 * **Adopting is not authorizing.** Using one of these tells this session where
 * the checkout is. It does not make it writable: the access mode still has to
 * be chosen, which is what issues a grant. That is why there is no "resume
 * editing here" button — there is no such action.
 *
 * **Removing says what it removes.** The confirmation names the files that
 * would be destroyed, because a prompt that only asks "are you sure" about a
 * path is one nobody can answer correctly.
 */

export type WorktreeRecoveryProps = {
  /** Flint-owned worktrees of this project that this session is not using. */
  orphans: readonly WorktreeRecord[]
  /** Told to the session, so it knows where the work is. */
  onAdopt: (record: WorktreeRecord) => void
  /** What removing this would destroy. Asked before the confirmation. */
  onPending: (record: WorktreeRecord) => Promise<string[]>
  /** Removes it. `force` is only ever what the user chose after seeing the list. */
  onRemove: (record: WorktreeRecord, force: boolean) => Promise<void>
  /** This session's own worktree branch, labelled so it can be told apart. */
  ownBranch?: string
  /**
   * Why the session dropped to review-only, when it was using a managed
   * worktree before a restart. Shown above the list.
   */
  downgradeNote?: string
  /** Stop offering earlier worktrees for this folder. */
  onHide?: () => void
}

export function CoworkWorktreeRecovery(props: WorktreeRecoveryProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState<{
    record: WorktreeRecord
    pending: string[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  // A one-line hint until asked: most sessions have nothing to recover.
  const [open, setOpen] = useState(false)

  if (props.orphans.length === 0) return null

  const ask = async (record: WorktreeRecord) => {
    setBusy(true)
    try {
      setConfirming({ record, pending: await props.onPending(record) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirming) return
    setBusy(true)
    try {
      // Forced only because the list above was shown: this is the click that
      // saw it.
      await props.onRemove(confirming.record, confirming.pending.length > 0)
      setConfirming(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="cowork-worktree-recovery"
      aria-label={t('common:worktreeRecovery.title')}
      className={
        open
          ? 'rounded-[10px] bg-muted px-3 py-2.5 text-xs shadow-[inset_0_0_0_0.8px_var(--border)] motion-safe:animate-rise-in'
          : 'text-xs text-muted-foreground'
      }
    >
      {props.downgradeNote && (
        <p className="mb-1 text-fg-2" data-testid="cowork-worktree-downgrade">
          {props.downgradeNote}
        </p>
      )}
      <p
        className={`flex items-center gap-1.5 ${open ? 'mb-1 text-fg-2' : ''}`}
      >
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <span>
          {t('common:worktreeRecovery.hint', { count: props.orphans.length })}
        </span>
        <span aria-hidden>·</span>
        <button
          type="button"
          className="underline-offset-2 hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open
            ? t('common:worktreeRecovery.collapse')
            : t('common:worktreeRecovery.review')}
        </button>
        {props.onHide ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={props.onHide}
            >
              {t('common:worktreeRecovery.dontShow')}
            </button>
          </>
        ) : null}
      </p>
      {open ? (
      <>
      <ul className="grid gap-1">
        {props.orphans.map((record) => (
          <li key={record.path} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={record.path}>
              {record.branch}
              {props.ownBranch && record.branch === props.ownBranch && (
                <span className="text-fg-2">
                  {' '}
                  {t('common:worktreeRecovery.thisSession')}
                </span>
              )}
              <span className="text-muted-foreground">
                {' — '}
                {shortPath(record.path)}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 pointer-coarse:h-11"
              disabled={busy}
              onClick={() => props.onAdopt(record)}
            >
              {t('common:worktreeRecovery.use')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 pointer-coarse:h-11"
              disabled={busy}
              onClick={() => void ask(record)}
            >
              {t('common:worktreeRecovery.remove')}
            </Button>
          </li>
        ))}
      </ul>
      {/* Adopting a checkout is not regaining write access to it, and saying so
          here is cheaper than the support thread that follows not saying it. */}
      <p className="mt-1 text-muted-foreground">
        {t('common:worktreeRecovery.noAuthority')}
      </p>
      </>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-label={t('common:worktreeRecovery.confirmTitle')}
          className="mt-2 rounded-lg border-[0.8px] border-destructive/30 bg-destructive-tint p-2.5"
        >
          <p className="text-destructive">
            {confirming.pending.length > 0
              ? t('common:worktreeRecovery.confirmDirty', {
                  count: confirming.pending.length,
                  files: describePending(confirming.pending),
                })
              : t('common:worktreeRecovery.confirmClean', {
                  branch: confirming.record.branch,
                })}
          </p>
          <div className="mt-1 flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="h-7 pointer-coarse:h-11"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t('common:worktreeRecovery.confirmRemove')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 pointer-coarse:h-11"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              {t('common:worktreeRecovery.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
