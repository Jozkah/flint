import { useEffect, useState } from 'react'
import { campaignApi, type TaskDiff } from '@/lib/campaignApi'
import type { CampaignTask } from '@/lib/campaignModel'

/** A running task's counts are re-read this often. */
export const SUMMARY_REFRESH_MS = 15_000

const NOT_STARTED: ReadonlySet<string> = new Set([
  'pending',
  'queued',
  'blocked',
])

/** Whether a task has a worktree that can be asked what it changed. */
export const hasWork = (
  task: Pick<CampaignTask, 'status' | 'worktreePath'>
): boolean => !!task.worktreePath && !NOT_STARTED.has(task.status)

/**
 * The counted summary of what a task changed ("2 files, +14 -3") for a board
 * row: files and lines, no patches. Null until it is known or when git cannot
 * say, in which case the row falls back to the session's recorded file count.
 */
export function useTaskDiffSummary(
  campaignId: string,
  task: Pick<CampaignTask, 'id' | 'status' | 'worktreePath'>,
  load: (id: string, taskId: string) => Promise<TaskDiff> = (id, taskId) =>
    campaignApi.taskDiff(id, taskId, false)
): TaskDiff | null {
  const [summary, setSummary] = useState<TaskDiff | null>(null)
  const eligible = hasWork(task)
  const running = task.status === 'running'
  useEffect(() => {
    if (!eligible) {
      setSummary(null)
      return
    }
    let alive = true
    const read = () =>
      load(campaignId, task.id)
        .then((d) => alive && setSummary(d))
        .catch(() => alive && setSummary(null))
    void read()
    const timer = running ? setInterval(() => void read(), SUMMARY_REFRESH_MS) : null
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
    // `load` is a module-level default or a test's fake; the status is what
    // changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, task.id, task.status, eligible, running])
  return summary
}
