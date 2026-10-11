import { useEffect, useId, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { create } from 'zustand'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useCampaignStore } from '@/hooks/useCampaigns'
import { errorText } from '@/lib/errorText'
import { formatTokenCount } from '@/lib/utils'
import {
  addTask,
  campaignPlanApi,
  linesOf,
  moveTask,
  patchTask,
  planChanged,
  planTasksOf,
  readEstimate,
  removeTask,
  validatePlan,
  type PlanIssue,
} from '@/lib/campaignPlanEdit'
import { CAMPAIGN_MAX_TASKS, type PlanTask } from '@/lib/campaignModel'
import { CAMPAIGN_PLAN_TOOL_NAME } from '@/lib/campaignToolNames'

/**
 * Plans with edits that are not saved yet, by campaign id. The approval card
 * keeps "Allow" disabled for these, so what is approved is what was saved.
 */
export const usePlanDraftStore = create<{
  dirty: Record<string, boolean>
  setDirty: (id: string, dirty: boolean) => void
}>()((set) => ({
  dirty: {},
  setDirty: (id, dirty) =>
    set((s) =>
      Boolean(s.dirty[id]) === dirty
        ? s
        : { dirty: { ...s.dirty, [id]: dirty } }
    ),
}))

/**
 * The plan card's data from an approval request, or null for any other tool.
 * The payload names the campaign (`campaign_id`), lists the tasks shortly and
 * may carry the backend's `estimate`.
 */
export function planCardOf(
  toolName: string,
  input: unknown
): { campaignId: string; estimate: unknown; tasks: PlanTask[] } | null {
  if (toolName !== CAMPAIGN_PLAN_TOOL_NAME) return null
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.campaign_id !== 'string' || !o.campaign_id) return null
  const rows = Array.isArray(o.tasks) ? o.tasks : []
  const tasks: PlanTask[] = rows.flatMap((r) => {
    if (!r || typeof r !== 'object') return []
    const x = r as Record<string, unknown>
    if (typeof x.id !== 'string') return []
    const strs = (v: unknown) =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
    return [
      {
        id: x.id,
        title: typeof x.title === 'string' ? x.title : x.id,
        brief: typeof x.brief === 'string' ? x.brief : '',
        paths: strs(x.paths),
        dependsOn: strs(x.depends_on),
      },
    ]
  })
  return { campaignId: o.campaign_id, estimate: o.estimate, tasks }
}

/** The plan issue in plain words, with the task names rather than ids. */
export function usePlanIssueText(tasks: readonly PlanTask[]) {
  const { t } = useTranslation()
  const name = (id: string) =>
    tasks.find((x) => x.id === id)?.title.trim() || id
  return (issue: PlanIssue): string => {
    switch (issue.code) {
      case 'noTasks':
        return t('settings:campaigns.plan.issue.noTasks')
      case 'tooMany':
        return t('settings:campaigns.plan.issue.tooMany', {
          count: issue.count,
          max: issue.max,
        })
      case 'emptyTitle':
        return t('settings:campaigns.plan.issue.emptyTitle', {
          task: name(issue.task),
        })
      case 'emptyBrief':
        return t('settings:campaigns.plan.issue.emptyBrief', {
          task: name(issue.task),
        })
      case 'badPath':
        return t('settings:campaigns.plan.issue.badPath', {
          task: name(issue.task),
          path: issue.path,
        })
      case 'selfDependency':
        return t('settings:campaigns.plan.issue.selfDependency', {
          task: name(issue.task),
        })
      case 'unknownDependency':
        return t('settings:campaigns.plan.issue.unknownDependency', {
          task: name(issue.task),
        })
      case 'cycle':
        return t('settings:campaigns.plan.issue.cycle', {
          tasks: issue.tasks.map(name).join(' → '),
        })
      case 'overlap':
        return t('settings:campaigns.plan.issue.overlap', {
          a: name(issue.a),
          b: name(issue.b),
          path: issue.path,
        })
    }
  }
}

/** "About 40k to 90k tokens" and what it depends on; nothing when unknown. */
export function PlanEstimate({ estimate }: { estimate: unknown }) {
  const { t } = useTranslation()
  const e = readEstimate(estimate)
  if (!e) return null
  return (
    <div
      data-testid="plan-estimate"
      className="flex flex-col gap-0.5 text-[13px]"
    >
      <p className="font-medium text-foreground">
        {e.low === e.high
          ? t('settings:campaigns.plan.estimate.one', {
              tokens: formatTokenCount(e.low),
            })
          : t('settings:campaigns.plan.estimate.range', {
              low: formatTokenCount(e.low),
              high: formatTokenCount(e.high),
            })}
      </p>
      <p className="text-xs text-muted-foreground">
        {e.basis.length > 0
          ? t('settings:campaigns.plan.estimate.basis', {
              basis: e.basis.join(', '),
            })
          : t('settings:campaigns.plan.estimate.generic')}
      </p>
    </div>
  )
}

const FIELD =
  'w-full rounded-md border-[0.8px] border-border bg-background px-2 py-1.5 text-[13px] outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40'

/** The task editor: one block per task, edits kept in local state. */
export function PlanEditor({
  campaignId,
  initial,
  onSaved,
  onCancel,
  save = campaignPlanApi.update,
}: {
  campaignId: string
  initial: PlanTask[]
  onSaved: () => void
  onCancel: () => void
  save?: (id: string, tasks: PlanTask[]) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<PlanTask[]>(initial)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const issueText = usePlanIssueText(tasks)
  const issues = useMemo(() => validatePlan(tasks), [tasks])
  const dirty = planChanged(initial, tasks)
  const baseId = useId()

  useEffect(() => {
    usePlanDraftStore.getState().setDirty(campaignId, dirty)
    return () => usePlanDraftStore.getState().setDirty(campaignId, false)
  }, [campaignId, dirty])

  const edit = (next: PlanTask[]) => {
    setFailure(null)
    setTasks(next)
  }
  const doSave = async () => {
    if (issues.length > 0 || saving) return
    setSaving(true)
    setFailure(null)
    try {
      await save(campaignId, tasks)
      await useCampaignStore.getState().refresh()
      toast.success(t('settings:campaigns.plan.saved'))
      onSaved()
    } catch (e) {
      setFailure(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="plan-editor" className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {tasks.map((task, i) => {
          const others = tasks.filter((x) => x.id !== task.id)
          const id = `${baseId}-${task.id}`
          const free = others.filter((x) => !(task.dependsOn ?? []).includes(x.id))
          return (
            <li
              key={task.id}
              data-testid={`plan-edit-task-${task.id}`}
              className="flex flex-col gap-2 rounded-lg border-[0.8px] border-border p-2.5"
            >
              <div className="flex items-center gap-1">
                <label htmlFor={`${id}-title`} className="sr-only">
                  {t('settings:campaigns.plan.field.title')}
                </label>
                <input
                  id={`${id}-title`}
                  value={task.title}
                  maxLength={120}
                  placeholder={t('settings:campaigns.plan.field.title')}
                  onChange={(e) =>
                    edit(patchTask(tasks, task.id, { title: e.target.value }))
                  }
                  className={`${FIELD} font-medium`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={i === 0}
                  aria-label={t('settings:campaigns.plan.moveUp', {
                    task: task.title || task.id,
                  })}
                  onClick={() => edit(moveTask(tasks, task.id, -1))}
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={i === tasks.length - 1}
                  aria-label={t('settings:campaigns.plan.moveDown', {
                    task: task.title || task.id,
                  })}
                  onClick={() => edit(moveTask(tasks, task.id, 1))}
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('settings:campaigns.plan.remove', {
                    task: task.title || task.id,
                  })}
                  data-testid={`plan-remove-${task.id}`}
                  onClick={() => edit(removeTask(tasks, task.id))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <label
                htmlFor={`${id}-brief`}
                className="text-xs text-muted-foreground"
              >
                {t('settings:campaigns.plan.field.brief')}
              </label>
              <Textarea
                id={`${id}-brief`}
                value={task.brief}
                rows={3}
                onChange={(e) =>
                  edit(patchTask(tasks, task.id, { brief: e.target.value }))
                }
                className="min-h-0 text-[13px]"
              />
              <label
                htmlFor={`${id}-acc`}
                className="text-xs text-muted-foreground"
              >
                {t('settings:campaigns.plan.field.acceptance')}
              </label>
              <Textarea
                id={`${id}-acc`}
                defaultValue={(task.acceptance ?? []).join('\n')}
                rows={2}
                onChange={(e) =>
                  edit(
                    patchTask(tasks, task.id, {
                      acceptance: linesOf(e.target.value),
                    })
                  )
                }
                className="min-h-0 text-[13px]"
              />
              <label
                htmlFor={`${id}-paths`}
                className="text-xs text-muted-foreground"
              >
                {t('settings:campaigns.plan.field.paths')}
              </label>
              <Textarea
                id={`${id}-paths`}
                defaultValue={(task.paths ?? []).join('\n')}
                rows={2}
                placeholder={t('settings:campaigns.plan.field.pathsHint')}
                onChange={(e) =>
                  edit(
                    patchTask(tasks, task.id, { paths: linesOf(e.target.value) })
                  )
                }
                className="min-h-0 font-mono text-xs"
              />
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t('settings:campaigns.plan.field.after')}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(task.dependsOn ?? []).map((dep, di) => (
                    <span key={`${dep}-${di}`} className="flex items-center gap-1">
                      <select
                        aria-label={t('settings:campaigns.plan.field.after')}
                        value={dep}
                        onChange={(e) =>
                          edit(
                            patchTask(tasks, task.id, {
                              dependsOn: (task.dependsOn ?? []).map((d, k) =>
                                k === di ? e.target.value : d
                              ),
                            })
                          )
                        }
                        className={`${FIELD} w-auto`}
                      >
                        {[dep, ...free.map((x) => x.id)].map((v) => (
                          <option key={v} value={v}>
                            {tasks.find((x) => x.id === v)?.title.trim() || v}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('settings:campaigns.plan.removeAfter')}
                        onClick={() =>
                          edit(
                            patchTask(tasks, task.id, {
                              dependsOn: (task.dependsOn ?? []).filter(
                                (_, k) => k !== di
                              ),
                            })
                          )
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </span>
                  ))}
                  {free.length > 0 && (
                    <select
                      aria-label={t('settings:campaigns.plan.addAfter')}
                      value=""
                      data-testid={`plan-add-after-${task.id}`}
                      onChange={(e) =>
                        e.target.value &&
                        edit(
                          patchTask(tasks, task.id, {
                            dependsOn: [...(task.dependsOn ?? []), e.target.value],
                          })
                        )
                      }
                      className={`${FIELD} w-auto text-muted-foreground`}
                    >
                      <option value="">
                        {t('settings:campaigns.plan.addAfter')}
                      </option>
                      {free.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.title.trim() || x.id}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={tasks.length >= CAMPAIGN_MAX_TASKS}
          data-testid="plan-add-task"
          onClick={() => edit(addTask(tasks))}
        >
          <Plus aria-hidden />
          {t('settings:campaigns.plan.addTask')}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('settings:campaigns.plan.count', {
            count: tasks.length,
            max: CAMPAIGN_MAX_TASKS,
          })}
        </span>
      </div>
      {issues.length > 0 && (
        <ul
          role="alert"
          data-testid="plan-issues"
          className="flex flex-col gap-0.5 text-xs text-destructive"
        >
          {issues.map((issue, i) => (
            <li key={i}>{issueText(issue)}</li>
          ))}
        </ul>
      )}
      {failure && (
        <p role="alert" className="text-xs text-destructive" data-testid="plan-save-error">
          {t('settings:campaigns.plan.saveFailed', { reason: failure })}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!dirty || issues.length > 0 || saving}
          data-testid="plan-save"
          onClick={() => void doSave()}
        >
          {t('settings:campaigns.plan.save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('settings:campaigns.plan.discard')}
        </Button>
        {dirty && (
          <span className="text-xs text-muted-foreground" role="status">
            {t('settings:campaigns.plan.unsaved')}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The plan on the approval card: the cost estimate, the tasks as a short
 * list, and "Edit plan" which opens the editor while the plan is still only
 * proposed. Reads the tasks from the campaign record so they stay right after
 * a save.
 */
export function CampaignPlanCard({
  campaignId,
  estimate,
  tasks: shown,
}: {
  campaignId: string
  estimate?: unknown
  /** What the approval payload lists, used until the record is known. */
  tasks?: PlanTask[]
}) {
  const { t } = useTranslation()
  const record = useCampaignStore((s) =>
    s.campaigns.find((c) => c.id === campaignId)
  )
  const [editing, setEditing] = useState(false)
  const tasks = record ? planTasksOf(record) : (shown ?? [])
  const editable = record?.status === 'planned' && tasks.length > 0
  const listId = useId()
  // The record can be missing right after the plan is made; ask for it.
  useEffect(() => {
    if (!record) void useCampaignStore.getState().refresh()
  }, [record])

  return (
    <div data-testid="plan-card" className="flex flex-col gap-2.5">
      <PlanEstimate estimate={estimate ?? (record as { estimate?: unknown } | undefined)?.estimate} />
      {!editing && tasks.length > 0 && (
        <ol
          id={listId}
          className="flex flex-col gap-1 text-[13px]"
          data-testid="plan-task-list"
        >
          {tasks.map((task, i) => {
            const after = (task.dependsOn ?? [])
              .map((d) => tasks.find((x) => x.id === d)?.title || d)
              .join(', ')
            return (
              <li key={task.id} className="flex min-w-0 gap-2">
                <span className="w-5 shrink-0 text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                <span className="min-w-0">
                  <span className="font-medium break-words">{task.title}</span>
                  {after && (
                    <span className="block text-xs text-muted-foreground">
                      {t('settings:campaigns.plan.after', { tasks: after })}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {editing && record && (
        <PlanEditor
          campaignId={campaignId}
          initial={tasks}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      )}
      {editable && !editing && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-controls={listId}
            data-testid="plan-edit"
            onClick={() => setEditing(true)}
          >
            {t('settings:campaigns.plan.edit')}
          </Button>
        </div>
      )}
    </div>
  )
}
