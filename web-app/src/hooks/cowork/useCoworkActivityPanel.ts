import { useSecondClock } from '@/lib/sharedClock'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { toast } from 'sonner'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import {
  finishedJobPatch,
} from '@/lib/coworkTasks'
import {
  findTaskByJob,
  backgroundTasksOf,
  sessionTotals,
  sessionWorkflows,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'
import {
  cancelMessage,
  cancelTask as cancelTaskRequest,
  cancelWorkflow as cancelWorkflowRequest,
  patchForOutcome,
} from '@/lib/coworkCancel'
import { recordLifecycle } from '@/lib/toolActivity'
import { type CoworkRail } from '@/hooks/useCoworkView'
import type { LiveJob } from '@/lib/coworkTasks'
import { hasSubagent } from '@/lib/coworkRunner'
import type { CoworkSession } from '@/hooks/useCoworkSessions'

export type CoworkActivityPanelArgs = {
  session: CoworkSession | null
  rail: { kind: "preview"; path?: string; root?: string; } | { kind: "diff"; focusPath?: string; } | { kind: "code"; } | { kind: "tasks"; } | { kind: "timeline"; } | { kind: "browser"; } | { kind: "background"; } | null
  setRail: (next: CoworkRail) => void
  liveJobsSession: string | undefined
  liveJobs: LiveJob[]
  t: (key: string, options?: Record<string, unknown>) => string
}

export function useCoworkActivityPanel({
  session,
  rail,
  setRail,
  liveJobsSession,
  liveJobs,
  t,
}: CoworkActivityPanelArgs) {

  // The one activity record. The panel, the chip and every inline workflow
  // card select from this, so none of them can disagree about the same work.
  const activityWorkflows = useCoworkActivity((s) => s.workflows)
  const activityTasks = useCoworkActivity((s) => s.tasks)
  const activity = useMemo(
    () => ({ workflows: activityWorkflows, tasks: activityTasks }),
    [activityWorkflows, activityTasks]
  )
  const workflowViews = useMemo(
    () => sessionWorkflows(activity, session?.id),
    [activity, session?.id]
  )
  const taskCounts = useMemo(
    () => sessionTotals(activity, session?.id),
    [activity, session?.id]
  )
  // The Background tasks tab reads the same record; it exists only while it
  // has rows.
  const backgroundTasks = useMemo(
    () =>
      session?.id
        ? backgroundTasksOf(activity, session.id)
        : { running: [], finished: [] },
    [activity, session?.id]
  )
  // Clearing the last row removes the tab, so its panel does not stay open on
  // nothing.
  const backgroundCount =
    backgroundTasks.running.length + backgroundTasks.finished.length
  useEffect(() => {
    if (rail?.kind === 'background' && backgroundCount === 0) setRail(null)
  }, [rail?.kind, backgroundCount, setRail])

  // The backend is the authority on whether a backgrounded shell is still
  // running: the agent may not collect a job for many turns, and until it does
  // nothing else would ever settle that row.
  // It also says how the command ended -- exit code, signal, or a stop request
  // -- so an uncollected failure reads as a failure, not a success.
  useEffect(() => {
    if (!liveJobsSession) return
    const state = useCoworkActivity.getState()
    for (const job of liveJobs) {
      if (!job.finished) continue
      const task = findTaskByJob(state, job.jobId, liveJobsSession)
      if (task && task.status === 'running') {
        const patch = finishedJobPatch(job)
        state.patchTask(task.id, { ...patch, endedAt: patch.endedAt ?? Date.now() })
      }
    }
  }, [liveJobs, liveJobsSession])

  // Advances the cards' elapsed labels. Only while work is live: an idle
  // conversation must not re-render every second.
  const activityActive = taskCounts.running + taskCounts.queued > 0
  const activityNow = useSecondClock(activityActive)

  // A task the inline card asked the panel to reveal.
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  const [focusWorkflowId, setFocusWorkflowId] = useState<string | null>(null)
  // `setRail` is bound to the session in view; with empty deps these kept the
  // one from the first render and opened the rail for no session at all.
  const showTaskInPanel = useCallback(
    (task: ActivityTask) => {
      setRail({ kind: 'tasks' })
      setFocusWorkflowId(task.workflowId)
      setFocusTaskId(task.id)
    },
    [setRail]
  )
  // A child in a checkout of its own: its row leads to the Changes panel, where
  // the review list shows that child's work.
  const [reviewFocusTaskId, setReviewFocusTaskId] = useState<string | null>(null)
  const reviewChildChanges = useCallback(
    (task: ActivityTask) => {
      setReviewFocusTaskId(task.checkout?.taskId ?? null)
      setRail({ kind: 'diff' })
    },
    [setRail]
  )
  const showWorkflowInPanel = useCallback(
    (workflowId: string) => {
      setRail({ kind: 'tasks' })
      setFocusTaskId(null)
      setFocusWorkflowId(workflowId)
    },
    [setRail]
  )

  // Whether the run still holds a controller for an agent task. Consulted
  // rather than assumed, so a Stop control is only offered where pressing it
  // would reach something.
  const sessionId = session?.id
  const agentReachable = useCallback(
    (task: ActivityTask) =>
      sessionId != null && hasSubagent(sessionId, task.id),
    [sessionId]
  )

  const applyCancel = useCallback(
    (
      task: ActivityTask,
      result: Awaited<ReturnType<typeof cancelTaskRequest>>
    ) => {
      const patch = patchForOutcome(result, Date.now())
      if (patch) useCoworkActivity.getState().patchTask(task.id, patch)
      // Into the execution record too, in sequence with the calls around it:
      // a stop is something the run did, and a stop that failed is one the
      // audit has to show as having failed.
      if (result.outcome === 'cancelled' || result.outcome === 'failed') {
        void recordLifecycle(
          {
            session: task.sessionId,
            run: task.workflowId,
            source: 'cowork',
            parent: task.callId,
          },
          {
            id: `stop:${task.callId}:${Date.now()}`,
            lifecycle: task.kind === 'shell' ? 'background-job' : 'subagent',
            phase: result.outcome === 'cancelled' ? 'cancelled' : 'failed',
            summary:
              task.kind === 'shell'
                ? `Stopped ${task.jobId ?? 'a command'}`
                : `Stopped ${task.title}`,
            detail: result.error ?? '',
            jobId: task.jobId,
            taskId: task.kind === 'agent' ? task.callId : undefined,
          }
        )
      }
      return patch != null
    },
    []
  )

  const cancelTask = useCallback(
    async (task: ActivityTask) => {
      if (!session?.id) return
      const result = await cancelTaskRequest(session.id, task)
      // Nothing was stopped. Say which of the reasons it was rather than
      // leaving the row looking as though the click did nothing.
      if (!applyCancel(task, result)) toast.info(cancelMessage(result, t))
    },
    [session?.id, applyCancel, t]
  )

  const cancelWorkflowTasks = useCallback(
    async (view: WorkflowView) => {
      if (!session?.id) return
      const outcome = await cancelWorkflowRequest(session.id, view, {
        agentReachable,
      })
      const byId = new Map(view.tasks.map((task) => [task.id, task]))
      for (const result of outcome.results) {
        const task = byId.get(result.taskId)
        if (task) applyCancel(task, result)
      }
      // Honest about a partial result: some children stopped, some did not.
      if (outcome.failed > 0) {
        toast.info(
          t('common:tasks.stopWorkflowPartial', {
            cancelled: outcome.cancelled,
            failed: outcome.failed,
          })
        )
      }
    },
    [session?.id, agentReachable, applyCancel, t]
  )
  return {
    taskCounts,
    backgroundTasks,
    activity,
    activityNow,
    showTaskInPanel,
    showWorkflowInPanel,
    reviewFocusTaskId,
    reviewChildChanges,
    workflowViews,
    focusWorkflowId,
    focusTaskId,
    setFocusTaskId,
    setFocusWorkflowId,
    agentReachable,
    cancelTask,
    cancelWorkflowTasks,
  }
}
