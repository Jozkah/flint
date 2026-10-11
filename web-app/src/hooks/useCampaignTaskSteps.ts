import { useEffect, useState } from 'react'
import { loadToolActivity, type ToolActivityItem } from '@/lib/toolActivity'
import { stepsOf, type Step } from '@/lib/campaignStory'
import type { CampaignTask } from '@/lib/campaignModel'

/** A running task's recorded steps are re-read this often. */
export const STEPS_REFRESH_MS = 15_000

/**
 * What a task's session did, in order, from its recorded tool activity.
 * Empty until read and when nothing was recorded (a task that has not
 * started, or a record that is gone): the board then simply tells less.
 */
export function useCampaignTaskSteps(
  task: Pick<CampaignTask, 'id' | 'sessionId' | 'status'>,
  load: (session: string) => Promise<ToolActivityItem[]> = loadToolActivity
): Step[] {
  const [steps, setSteps] = useState<Step[]>([])
  const session = task.sessionId ?? null
  const running = task.status === 'running'
  useEffect(() => {
    if (!session) {
      setSteps([])
      return
    }
    let alive = true
    const read = () =>
      load(session).then(
        (items) => alive && setSteps(stepsOf(items)),
        () => alive && setSteps([])
      )
    void read()
    const timer = running
      ? setInterval(() => void read(), STEPS_REFRESH_MS)
      : null
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
    // `load` is a module-level default or a test's fake; the session and the
    // status are what change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, task.status, running])
  return steps
}
