import { useState } from 'react'
import { GitBranch, TriangleAlert } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Remembers that the shared-tree warning was shown, so it appears once. */
export const SHARED_WARNED_KEY = 'flint.sharedFolder.warned'

function warnedBefore(): boolean {
  try {
    return localStorage.getItem(SHARED_WARNED_KEY) === '1'
  } catch {
    return false
  }
}

function rememberWarned() {
  try {
    localStorage.setItem(SHARED_WARNED_KEY, '1')
  } catch {
    // Storage may be unavailable; the warning then shows again next time.
  }
}

/**
 * Where the worktree choice is shown: one line saying why this session got its
 * own worktree (another session works in the folder), with the way back to the
 * shared tree. After that choice, a single inline warning about the git state
 * guard, once.
 */
export function SharedFolderIsolationHint({
  reason,
  choseShared,
  onUseShared,
}: {
  /** Why the default isolated the session; null when it did not. */
  reason: 'fork' | 'secondSession' | null
  /** The person chose the shared tree for this session. */
  choseShared: boolean
  onUseShared: () => void
}) {
  const { t } = useTranslation()
  const [warn, setWarn] = useState(false)
  // Computed on the click that made the choice, not on render, so a later
  // render does not hide the warning the moment it is stored.
  const showWarning = warn || (choseShared && !warnedBefore())
  if (choseShared && !showWarning) return null
  if (choseShared || warn)
    return (
      <div
        role="status"
        data-testid="shared-folder-warning"
        className="mb-1.5 flex items-start gap-2 rounded-[10px] bg-muted px-2.5 py-1.5 text-xs text-warning shadow-[inset_0_0_0_0.8px_var(--border)]"
      >
        <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 text-secondary-foreground">
          {t('common:sharedFolder.sharedWarning')}
        </span>
        <button
          type="button"
          data-testid="shared-folder-warning-dismiss"
          className="shrink-0 text-muted-foreground hover:underline"
          onClick={() => {
            rememberWarned()
            setWarn(false)
          }}
        >
          {t('common:sharedFolder.gotIt')}
        </button>
      </div>
    )
  if (!reason) return null
  return (
    <div
      data-testid="shared-folder-isolation"
      data-reason={reason}
      className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 text-xs text-muted-foreground"
    >
      <GitBranch aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {t('common:sharedFolder.isolationHint')}
      </span>
      <button
        type="button"
        data-testid="shared-folder-use-shared"
        className="shrink-0 text-info hover:underline"
        onClick={() => {
          setWarn(!warnedBefore())
          onUseShared()
        }}
      >
        {t('common:sharedFolder.useShared')}
      </button>
    </div>
  )
}
