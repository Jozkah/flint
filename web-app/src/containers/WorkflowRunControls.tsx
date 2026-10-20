import { Pause, Play, RotateCcw, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTeamControls } from '@/hooks/useTeamControls'
import type { ActivityTask } from '@/lib/coworkActivity'
import { safeId } from '@/lib/workflowRuns'
import type { TeamControl } from '@/lib/coworkTeamControl'

/**
 * The live team behind a `workflow` run: the host row its agents hang off and
 * the `TeamControl` (AH-111) that steers it. Undefined once the run has ended,
 * which is when the buttons go away.
 */
export function liveWorkflowTeam(
  tasks: ActivityTask[],
  controls: Record<string, TeamControl>
): { host?: ActivityTask; hostId: string; control: TeamControl } | undefined {
  // A child's `parentTaskId` is the host's task id, or its raw call id before
  // the activity hook resolves it; accept both.
  const raw = tasks.find((task) => task.phase && task.parentTaskId)?.parentTaskId
  if (!raw) return undefined
  const host = tasks.find((task) => task.id === raw || task.callId === raw)
  const hostId = host?.id ?? raw
  const control = controls[hostId]
  if (!control || control.finished) return undefined
  return { host, hostId, control }
}

/** A team member's own id: the part of its call id after the team's. */
export const memberIdOfTask = (task: ActivityTask): string => {
  const at = task.callId.lastIndexOf(':')
  return at >= 0 ? task.callId.slice(at + 1) : task.callId
}

/** Pause / Resume for a running workflow, in its card and in the panel. */
export function WorkflowPauseButton({ tasks }: { tasks: ActivityTask[] }) {
  const { t } = useTranslation()
  const controls = useTeamControls((s) => s.controls)
  const live = liveWorkflowTeam(tasks, controls)
  if (!live) return null
  const paused = live.host?.paused === true
  return (
    <Button
      variant="outline"
      size="xs"
      className="shrink-0 pointer-coarse:h-11"
      data-testid={paused ? 'workflow-resume' : 'workflow-pause'}
      onClick={() => live.control.request({ kind: paused ? 'resume' : 'pause' })}
    >
      {paused ? <Play aria-hidden className="size-3" /> : <Pause aria-hidden className="size-3" />}
      {paused ? t('common:tasks.resumeRun') : t('common:tasks.pauseRun')}
    </Button>
  )
}

/** Restart for one running agent of a live workflow. Failed ones have their own controls. */
export function WorkflowAgentRestart({ task, tasks }: { task: ActivityTask; tasks: ActivityTask[] }) {
  const { t } = useTranslation()
  const controls = useTeamControls((s) => s.controls)
  const live = liveWorkflowTeam(tasks, controls)
  if (!live || task.status !== 'running' || (task.parentTaskId !== live.hostId && task.parentTaskId !== live.host?.callId)) return null
  return (
    <button
      type="button"
      title={t('common:tasks.restartAgent')}
      aria-label={t('common:tasks.restartAgent')}
      data-testid={`workflow-restart-${memberIdOfTask(task)}`}
      onClick={() => live.control.request({ kind: 'restart', taskId: memberIdOfTask(task) })}
      className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-hover-row hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:size-11"
    >
      <RotateCcw aria-hidden className="size-3" />
    </button>
  )
}

/** Shown while a run is paused, so a quiet card is not read as a hang. */
export function WorkflowPausedBadge({ tasks }: { tasks: ActivityTask[] }) {
  const { t } = useTranslation()
  const controls = useTeamControls((s) => s.controls)
  const live = liveWorkflowTeam(tasks, controls)
  if (!live?.host?.paused) return null
  return (
    <span className="font-medium text-warning" data-testid="workflow-paused">
      {t('common:tasks.runPaused')}
    </span>
  )
}

/**
 * The run id of a workflow that stopped short, when it can be resumed: its host
 * row ended in error, cancelled or interrupted. The id is the host's call id,
 * which is the one its saved results are filed under.
 */
export function resumableRunId(tasks: ActivityTask[]): string | undefined {
  const raw = tasks.find((task) => task.phase && task.parentTaskId)?.parentTaskId
  if (!raw) return undefined
  const host = tasks.find((task) => task.id === raw || task.callId === raw)
  if (!host || !['error', 'cancelled', 'interrupted'].includes(host.status)) return undefined
  return safeId(host.callId)
}

/** Resume for a stopped or failed run: relaunch it from its saved results. */
export function WorkflowResumeButton({
  tasks,
  onResume,
}: {
  tasks: ActivityTask[]
  onResume?: (runId: string) => void
}) {
  const { t } = useTranslation()
  const runId = resumableRunId(tasks)
  if (!runId || !onResume) return null
  return (
    <Button
      variant="outline"
      size="xs"
      className="shrink-0 pointer-coarse:h-11"
      data-testid="workflow-resume-run"
      title={t('common:tasks.resumeFromSavedHint')}
      onClick={() => onResume(runId)}
    >
      <History aria-hidden className="size-3" />
      {t('common:tasks.resumeFromSaved')}
    </Button>
  )
}
