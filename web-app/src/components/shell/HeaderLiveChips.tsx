import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, ShieldAlert } from 'lucide-react'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useThreads } from '@/hooks/useThreads'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { openWaitingApproval } from '@/hooks/useApprovalWaitNotifier'
import { useRoomsState } from '@/containers/rooms/roomsBindings'
import { openApprovalDestination } from '@/lib/approvalDestination'
import {
  formatWait,
  runningRows,
  waitingApprovalRows,
} from '@/lib/headerLiveWork'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** One row of a pill's card, in the sidebar chat hover card's style. */
function CardRow({
  title,
  detail,
  time,
  onOpen,
  testId,
}: {
  title: string
  detail?: string
  time?: string
  onOpen: () => void
  testId: string
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid={testId}
        className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-start outline-hidden transition-colors hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <span className="line-clamp-1 text-[0.8125rem] font-medium text-foreground">
          {title}
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-subtle-foreground">
          {detail && <span className="min-w-0 truncate">{detail}</span>}
          {time && <span className="ml-auto shrink-0 tabular-nums">{time}</span>}
        </span>
      </button>
    </li>
  )
}

/** A clock that ticks once a second while something is live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * The header's live-work pills. Each opens what needs attention (the oldest
 * waiting approval; the one run in progress) and, on hover, lists every item
 * with a row that opens it.
 */
export function HeaderLiveChips() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const runs = useCoworkRun((s) => s.runs ?? {})
  const liveTurns = useCoworkRun((s) => s.liveTurns ?? {})
  const approvalState = useToolApprovalRequests((s) => s)
  const pendingEntries = useMemo(
    () => allApprovalRequests(approvalState),
    [approvalState]
  )
  const sessions = useCoworkSessions((s) => s.sessions)
  const threads = useThreads((s) => s.threads)
  const { summaries } = useRoomsState()
  const runCount = Object.keys(runs).length
  const approvalCount = pendingEntries.length
  const now = useNow(runCount > 0 || approvalCount > 0)
  const [runsOpen, setRunsOpen] = useState(false)
  const [approvalsOpen, setApprovalsOpen] = useState(false)

  const titleOf = (id: string) =>
    sessions.find((s) => s.id === id)?.title ||
    threads[id]?.title ||
    summaries.find((r) => r.id === id)?.title ||
    undefined
  const approvalRows = waitingApprovalRows(pendingEntries, titleOf, now)
  const runRows = runningRows(runs, titleOf, liveTurns, now)

  const openRun = (sessionId: string) => {
    setRunsOpen(false)
    openApprovalDestination({ kind: 'cowork', id: sessionId }, navigate, (id) =>
      useCoworkSessions.getState().selectSession(id)
    )
  }
  const openApproval = (row: { requestId: string; threadId: string }) => {
    setApprovalsOpen(false)
    openWaitingApproval(row, navigate)
  }

  return (
    <>
      {runCount > 0 && (
        <HoverCard openDelay={250} closeDelay={120} open={runsOpen} onOpenChange={setRunsOpen}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              className="hidden h-[26px] cursor-pointer items-center gap-1.5 rounded-full border-[0.8px] border-border bg-card px-2.5 text-[11.5px] font-medium whitespace-nowrap text-secondary-foreground transition-shadow hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden md:inline-flex"
              aria-label={t('common:shell.runsTitle')}
              aria-haspopup="dialog"
              data-testid="header-runs-chip"
              onClick={() => {
                // One run: open it. Several: show the list to choose from.
                if (runRows.length === 1) openRun(runRows[0].sessionId)
                else setRunsOpen(true)
              }}
            >
              <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />
              {t('common:shell.runs', { count: runCount })}
            </button>
          </HoverCardTrigger>
          <HoverCardContent align="end" sideOffset={8} className="w-72 p-2" data-testid="header-runs-card">
            <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-subtle-foreground">
              {t('common:shell.runsTitle')}
            </p>
            <ul className="flex flex-col">
              {runRows.map((row) => (
                <CardRow
                  key={row.sessionId}
                  testId="header-run-row"
                  title={row.title || t('common:newSession')}
                  detail={row.step}
                  time={formatWait(row.elapsedMs)}
                  onOpen={() => openRun(row.sessionId)}
                />
              ))}
            </ul>
          </HoverCardContent>
        </HoverCard>
      )}
      {approvalCount > 0 && (
        <HoverCard
          openDelay={250}
          closeDelay={120}
          open={approvalsOpen}
          onOpenChange={setApprovalsOpen}
        >
          <HoverCardTrigger asChild>
            {/* Actionable: opens the conversation that has waited longest. */}
            <button
              type="button"
              className="hidden h-[26px] cursor-pointer items-center gap-1.5 rounded-full border border-warning bg-warning px-2.5 text-[11.5px] font-semibold whitespace-nowrap text-white shadow-md shadow-warning/30 transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-warning/50 focus-visible:outline-hidden md:inline-flex"
              data-testid="header-approvals-chip"
              aria-label={t('common:shell.approvalWaiting')}
              aria-haspopup="dialog"
              onClick={() => {
                if (approvalRows[0]) openApproval(approvalRows[0])
              }}
            >
              <span className="relative flex size-2" aria-hidden>
                <span className="absolute inline-flex size-full rounded-full bg-white/80 motion-safe:animate-ping" />
                <span className="relative inline-flex size-2 rounded-full bg-white" />
              </span>
              <ShieldAlert className="size-3" aria-hidden />
              {t('common:shell.approvals', { count: approvalCount })}
            </button>
          </HoverCardTrigger>
          <HoverCardContent align="end" sideOffset={8} className="w-72 p-2" data-testid="header-approvals-card">
            <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-subtle-foreground">
              {t('common:shell.approvalWaiting')}
            </p>
            <ul className="flex flex-col">
              {approvalRows.map((row) => (
                <CardRow
                  key={row.requestId}
                  testId="header-approval-row"
                  title={row.title || t('common:newThread')}
                  detail={row.tool}
                  time={row.waitingMs === undefined ? undefined : formatWait(row.waitingMs)}
                  onOpen={() => openApproval(row)}
                />
              ))}
            </ul>
          </HoverCardContent>
        </HoverCard>
      )}
    </>
  )
}
