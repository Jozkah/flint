import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { CoworkTasksChip } from '@/containers/CoworkTasksChip'
import { CoworkTasksPanel } from '@/containers/CoworkTasksPanel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import {
  cancelMessage,
  cancelTask,
  cancelWorkflow,
  patchForOutcome,
} from '@/lib/coworkCancel'
import { hasSubagent } from '@/lib/coworkRunner'
import {
  sessionTotals,
  sessionWorkflows,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'

/**
 * The Tasks chip and panel for a plain chat.
 *
 * The same two components Cowork uses, reading the same activity store, so a
 * subagent a chat started looks and behaves exactly as it does there: its row,
 * its transcript, its stats, its Stop. Absent until the conversation has
 * started something, like the chip in Cowork. The panel opens in a side sheet,
 * since a chat has no output rail to dock it in.
 */
export function ChatTasks({ threadId }: { threadId: string }) {
  const { t } = useTranslation()
  const workflows = useCoworkActivity((s) => s.workflows)
  const tasks = useCoworkActivity((s) => s.tasks)
  const activity = useMemo(() => ({ workflows, tasks }), [workflows, tasks])
  const views = useMemo(() => sessionWorkflows(activity, threadId), [activity, threadId])
  const totals = useMemo(() => sessionTotals(activity, threadId), [activity, threadId])
  const [open, setOpen] = useState(false)

  const stopTask = useCallback(
    async (task: ActivityTask) => {
      const result = await cancelTask(threadId, task)
      const patch = patchForOutcome(result, Date.now())
      if (patch) useCoworkActivity.getState().patchTask(task.id, patch)
      else toast.info(cancelMessage(result, t))
    },
    [threadId, t]
  )
  const stopWorkflow = useCallback(
    async (view: WorkflowView) => {
      const outcome = await cancelWorkflow(threadId, view, {
        agentReachable: (one: ActivityTask) => hasSubagent(threadId, one.id),
      })
      const byId = new Map(view.tasks.map((task) => [task.id, task]))
      for (const result of outcome.results) {
        const task = byId.get(result.taskId)
        const patch = task ? patchForOutcome(result, Date.now()) : null
        if (task && patch) useCoworkActivity.getState().patchTask(task.id, patch)
      }
    },
    [threadId]
  )

  if (totals.total === 0) return null
  return (
    <>
      <div className="flex justify-end pb-1" data-testid="chat-tasks">
        <CoworkTasksChip totals={totals} open={open} onToggle={() => setOpen((v) => !v)} />
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-md">
          <SheetTitle className="sr-only">{t('common:tasks.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('common:tasks.empty')}</SheetDescription>
          <CoworkTasksPanel
            workflows={views}
            totals={totals}
            agentReachable={(task) => hasSubagent(threadId, task.id)}
            onCancelTask={stopTask}
            onCancelWorkflow={stopWorkflow}
            onClearFinished={() => useCoworkActivity.getState().clearFinished(threadId)}
            onClose={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  )
}
