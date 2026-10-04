/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from 'react'
import { GitBranch } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ActivityTask } from '@/lib/coworkActivity'

/**
 * Leads from a task row to the Changes panel, where the work of a child that
 * ran in a checkout of its own waits for review. Provided by the route, so the
 * Tasks panel and the Background tasks tab link the same way without either
 * threading a callback through every row.
 */
export const ReviewChangesContext = createContext<
  ((task: ActivityTask) => void) | undefined
>(undefined)

/** "Works in its own checkout · branch" with a Review changes button, or
 * nothing for a task that shares the folder. */
export function TaskCheckoutLink({ task }: { task: ActivityTask }) {
  const { t } = useTranslation()
  const open = useContext(ReviewChangesContext)
  if (!task.checkout) return null
  return (
    <p
      className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground"
      data-testid="task-checkout"
    >
      <GitBranch size={11} aria-hidden className="shrink-0" />
      <span>{t('common:tasks.ownCheckout')}</span>
      <span className="font-mono" title={task.checkout.path}>
        {task.checkout.branch}
      </span>
      {open ? (
        <button
          type="button"
          onClick={() => open(task)}
          className="text-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {t('common:tasks.reviewChanges')}
        </button>
      ) : null}
    </p>
  )
}
