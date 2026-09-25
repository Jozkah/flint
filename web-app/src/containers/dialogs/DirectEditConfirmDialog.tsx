import { useState } from 'react'
import { OctagonAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { modeLabelKey } from '@/lib/coworkMode'
import type { CoworkMode } from '@/lib/coworkMode'

/**
 * The moment a folder stops being read-only.
 *
 * Everything here is a fact about what is about to be permitted, gathered
 * before the question is asked: the canonical path rather than what the user
 * typed, the branch, whether the tree is already dirty, what the current run
 * mode will do with the permission, and how long it lasts. The point is that
 * someone can refuse for a good reason — a dirty tree, the wrong branch, the
 * wrong folder entirely.
 *
 * Confirming does not switch anything. It asks the backend for a grant, and
 * the caller changes the mode only if one is issued; a dialog that closed
 * optimistically would be claiming an authority nobody had yet.
 */

export type DirectEditFacts = {
  /** Canonical, as the backend resolved it. */
  folder: string
  name: string
  branch?: string | null
  /** Absent when the folder is not a Git repository or the status failed. */
  git: 'clean' | 'dirty' | 'not-a-repo' | 'unknown'
  runMode: CoworkMode
  shellAvailable: boolean
  /** Which sandbox will hold the line — `seatbelt`, `bubblewrap`. */
  backend: string
}

export type DirectEditConfirmDialogProps = {
  open: boolean
  facts: DirectEditFacts
  /** Resolves true once a grant exists; false leaves the session as it was. */
  onConfirm: () => Promise<boolean>
  onCancel: () => void
}

const gitKey = (git: DirectEditFacts['git']): string =>
  git === 'clean'
    ? 'common:coworkAccess.confirm.gitClean'
    : git === 'dirty'
      ? 'common:coworkAccess.confirm.gitDirty'
      : git === 'not-a-repo'
        ? 'common:coworkAccess.confirm.gitNone'
        : 'common:coworkAccess.confirm.gitUnknown'

const modeConsequenceKey = (mode: CoworkMode): string =>
  mode === 'review'
    ? 'common:coworkAccess.confirm.modeReview'
    : mode === 'ask'
      ? 'common:coworkAccess.confirm.modeAsk'
      : 'common:coworkAccess.confirm.modeAuto'

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

export function DirectEditConfirmDialog({
  open,
  facts,
  onConfirm,
  onCancel,
}: DirectEditConfirmDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    // Guarded rather than debounced: a second press while the first is in
    // flight would ask for a second grant and strand the first.
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const granted = await onConfirm()
      if (!granted) {
        setError(t('common:coworkAccess.confirm.failed', { reason: '' }))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('common:coworkAccess.confirm.title')}</DialogTitle>
          <DialogDescription>
            {t('common:coworkAccess.confirm.description')}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid gap-1 rounded-md border border-border bg-muted px-3 py-2 text-xs">
          <Fact
            label={t('common:coworkAccess.confirm.folder')}
            value={facts.folder}
          />
          <Fact
            label={t('common:coworkAccess.confirm.branch')}
            value={facts.branch ?? t('common:readiness.unknown')}
          />
          <Fact label="Git" value={t(gitKey(facts.git))} />
          <Fact
            label={t('common:coworkAccess.confirm.runMode')}
            value={t(modeLabelKey(facts.runMode))}
          />
          <Fact
            label={t('common:coworkAccess.confirm.shell')}
            value={t(
              facts.shellAvailable
                ? 'common:coworkAccess.confirm.shellYes'
                : 'common:coworkAccess.confirm.shellNo'
            )}
          />
          <Fact
            label={t('common:coworkAccess.confirm.backend')}
            value={facts.backend}
          />
        </dl>

        <div className="space-y-1.5 text-xs text-fg-2">
          {/* What the current run mode will actually do with the permission,
              so the two controls are not read independently. */}
          <p>{t(modeConsequenceKey(facts.runMode))}</p>
          <p>{t('common:coworkAccess.confirm.existingChanges')}</p>
          <p>{t('common:coworkAccess.confirm.duration')}</p>
        </div>

        {error && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-xs text-destructive"
          >
            <OctagonAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}

        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            className="pointer-coarse:h-11"
            onClick={onCancel}
            disabled={busy}
          >
            {t('common:coworkAccess.confirm.cancel')}
          </Button>
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy
              ? t('common:coworkAccess.confirm.working')
              : t('common:coworkAccess.confirm.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
