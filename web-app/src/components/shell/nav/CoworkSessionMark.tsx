import { useTranslation } from '@/i18n/react-i18next-compat'
import { ThreadStatusMark, useThreadStatus, type ThreadStatus } from '@/containers/ThreadStatusMark'
import { usePrStatus } from '@/stores/pr-status-store'
import { useSharedWith } from '@/stores/shared-folder-store'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { type CoworkSession } from '@/hooks/useCoworkSessions'
import { useHeldMailCount, useWaitingOnUser } from '@/hooks/useHeldMail'

/**
 * The mark before a session: waiting on the user, working, waiting on a pull
 * request's review, or
 * recently active. A session whose folder is on a branch with a pull request
 * shows that request's state (read through the GitHub CLI).
 */
export function SessionMark({
  session,
  running,
  selected,
}: {
  session: Pick<CoworkSession, 'id' | 'folder' | 'updated'>
  running: boolean
  selected: boolean
}) {
  // The session's own worktree when it has one: its branch, not the folder's.
  const worktreePath = useCoworkWorktrees((s) => s.bySession[session.id]?.path)
  const pr = usePrStatus(worktreePath ?? session.folder, session.id)
  // Waiting on the user: a tool approval, a question the run asked, or mail
  // from another session held for them.
  const waiting = useWaitingOnUser(session.id)
  const heldMail = useHeldMailCount(session.id)
  const sharedWith = useSharedWith(session.id)
  const { t } = useTranslation()
  const recency = useThreadStatus(
    { updated: session.updated },
    running,
    waiting,
    {
      id: `cowork:${session.id}`,
      selected,
    }
  )
  const status: ThreadStatus = waiting
    ? 'wait'
    : running
      ? 'active'
      : pr
        ? pr.state === 'open'
          ? 'pr'
          : pr.state
        : recency
  return (
    <span className="relative inline-flex shrink-0">
      <ThreadStatusMark
        status={status}
        shared={sharedWith}
        detail={
          heldMail > 0
            ? t('messaging:waitingCount', { count: heldMail })
            : pr
              ? `#${pr.number}`
              : undefined
        }
      />
      {heldMail > 1 && (
        <span
          data-testid="held-mail-count"
          aria-hidden
          className="absolute -top-1.5 -right-1.5 min-w-3 rounded-full bg-warning px-0.5 text-center text-[length:calc(var(--ui-font-base)*0.5625)] leading-3 font-medium text-background"
        >
          {heldMail > 9 ? '9+' : heldMail}
        </span>
      )}
    </span>
  )
}
