import { useEffect, useState } from 'react'
import type {
  CampaignActionWire,
  CampaignDetailResult,
  CampaignTaskWire,
  CampaignWire,
} from '@/lib/remote/protocol'
import { groupTasks, taskActionsOf, wordOf, TASK_GROUPS } from '@/lib/campaignView'
import { TopBack } from '../shell/TopBar'
import { Empty, Loading } from '../ui/bits'
import { ApprovalCard } from '../ui/ApprovalCard'
import { I } from '../ui/icons'
import { act, go } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { RemoteCallError } from '../api/client'
import { headlineOf, headlineText, modelOf, primaryActionOf, taskModel } from '../state/campaigns'
import { t } from '../i18n'

const POLL_MS = 4_000

type Run = (
  action: CampaignActionWire,
  taskId?: string,
  ok?: string,
  confirm?: string,
  extra?: { acknowledged?: string[] }
) => void

const CHANGE_LABEL = {
  added: () => t('campaigns.review.added'),
  modified: () => t('campaigns.review.modified'),
  deleted: () => t('campaigns.review.deleted'),
} as const

function filesText(f: NonNullable<CampaignTaskWire['files']>): string {
  const base = t('campaigns.files', { count: f.count, added: f.added, removed: f.removed })
  return f.uncommitted ? `${base} · ${t('campaigns.filesUncommitted')}` : base
}

function TaskRow({ task, all, run }: { task: CampaignTaskWire; all: CampaignWire['tasks']; run: Run }) {
  const model = taskModel(task)
  const { word, waitingFor } = wordOf(model, all.map(taskModel))
  const can = taskActionsOf(model)
  const hot = ['awaiting_input', 'awaiting_approval', 'failed', 'conflict'].includes(task.status)
  const moving = ['running', 'verifying', 'completed'].includes(task.status)
  return (
    <div className="frame cptask" data-testid="campaign-task" data-status={task.status}>
      <div className="cphd">
        <span className={`sd ${hot ? 'wait' : moving ? 'run' : ''}`} />
        <b>{task.title}</b>
      </div>
      <small className="muted">
        {t(`campaigns.word.${word}`, { names: waitingFor.join(', ') })}
        {task.files && task.files.count > 0 ? ` · ${filesText(task.files)}` : ''}
      </small>
      {hot && task.detail && <small className="cpdetail">{task.detail}</small>}
      <div className="cpbtns">
        {can.open && task.sessionId && (
          <button type="button" className="btn sm" onClick={() => go({ name: 'cowork', id: task.sessionId! })}>
            {t('campaigns.openTask')}
          </button>
        )}
        {can.retry && (
          <button type="button" className="btn sm pri" onClick={() => run('retry', task.id, t('campaigns.taskRetried'))}>
            {t('campaigns.retry')}
          </button>
        )}
        {can.skip && (
          <button
            type="button"
            className="btn sm"
            onClick={() => run('skip', task.id, t('campaigns.taskSkipped'), t('campaigns.skipConfirm'))}
          >
            {t('campaigns.skip')}
          </button>
        )}
        {task.status === 'running' && (
          <button type="button" className="btn sm dan" onClick={() => run('stop', task.id, t('campaigns.taskStopped'))}>
            {t('campaigns.stop')}
          </button>
        )}
      </div>
    </div>
  )
}

function ReviewPanel({ d, busy, run }: { d: CampaignDetailResult; busy: boolean; run: Run }) {
  const { campaign, proposal, gateCommand } = d
  const [looked, setLooked] = useState<string[]>([])
  if (proposal && proposal.state === 'pending') {
    const apply = proposal.files.filter((f) => !f.sensitive)
    const ready = apply.filter((f) => f.flags.length > 0).every((f) => looked.includes(f.path))
    return (
      <section className="frame cpreview" data-testid="campaign-review">
        <b>{t('campaigns.review.title')}</b>
        <small className="muted">{t('campaigns.review.changes', { count: apply.length })}</small>
        {proposal.files.map((f) => (
          <div key={f.path} className="cpfile">
            <span className="cpname">
              <span className="bdg">{CHANGE_LABEL[f.change]()}</span> {f.path}
            </span>
            <small className="muted">
              {f.binary ? t('campaigns.review.binary') : `+${f.additions} -${f.deletions}`}
              {f.sensitive ? ` · ${t('campaigns.review.sensitive')}` : ''}
            </small>
            {!f.sensitive && f.flags.length > 0 && (
              <label className="cpflag">
                <input
                  type="checkbox"
                  checked={looked.includes(f.path)}
                  onChange={(e) =>
                    setLooked((cur) => (e.target.checked ? [...cur, f.path] : cur.filter((p) => p !== f.path)))
                  }
                />
                <span>
                  <b>{t('campaigns.review.flagged')}</b> {f.flags.join('; ')}
                  <br />
                  {t('campaigns.review.looked')}
                </span>
              </label>
            )}
          </div>
        ))}
        {!ready && <small className="muted">{t('campaigns.review.tickFirst')}</small>}
        <button
          type="button"
          className="btn pri"
          disabled={busy || !ready || apply.length === 0}
          onClick={() =>
            run('apply', undefined, t('campaigns.review.applied'), t('campaigns.review.applyConfirm', { count: apply.length }), {
              acknowledged: looked,
            })
          }
        >
          {t('campaigns.review.apply')}
        </button>
      </section>
    )
  }
  if (campaign.status !== 'reviewing') return null
  const failed = campaign.gate && !campaign.gate.passed && !campaign.gate.skipped
  return (
    <section className="frame cpreview" data-testid="campaign-review">
      <b>{t('campaigns.review.title')}</b>
      <small className="muted">
        {gateCommand ? t('campaigns.review.gate', { command: gateCommand }) : t('campaigns.review.noGate')}
      </small>
      {failed && <small className="cpdetail">{t('campaigns.review.gateFailed', { command: campaign.gate!.command })}</small>}
      <button
        type="button"
        className="btn pri"
        disabled={busy}
        onClick={() => run('finalize', undefined, t('campaigns.review.prepared'))}
      >
        {t('campaigns.review.prepare')}
      </button>
    </section>
  )
}

export default function Campaign({ id }: { id: string }) {
  const detail = useRpc('campaigns.get', { id })
  const status = useRpc('status', {})
  const waiting = (status.data?.approvalsWaiting ?? 0) > 0
  const approvals = useRpc('approvals.list', {}, waiting)
  const [busy, setBusy] = useState(false)
  const { reload } = detail
  useEffect(() => {
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [reload])

  const d = detail.data
  const c = d?.campaign
  const sessions = new Set(
    c ? [c.coordinatorSession, ...c.tasks.flatMap((x) => (x.sessionId ? [x.sessionId] : []))] : []
  )
  const mine = (approvals.data?.approvals ?? []).filter((a) => sessions.has(a.threadId))

  const run: Run = (action, taskId, ok, confirm, extra = {}) => {
    if (confirm && !window.confirm(confirm)) return
    setBusy(true)
    void act('approvals.campaign.act', { id, action, ...(taskId ? { taskId } : {}), ...extra }, ok)
      .then(() => {
        invalidate(['campaigns.', 'status'])
        reload()
      })
      .finally(() => setBusy(false))
  }

  const old = detail.error instanceof RemoteCallError && ['unknown_method', 'not_implemented'].includes(detail.error.code)
  const model = c ? modelOf(c) : null
  const h = model ? headlineOf(model) : null
  const primary = model ? primaryActionOf(model) : null
  const over = c ? ['done', 'failed', 'cancelled'].includes(c.status) : true
  const groups = c ? groupTasks(c.tasks.map(taskModel)) : []
  const pct = h && h.total > 0 ? Math.round((h.done / h.total) * 100) : 0

  return (
    <>
      <TopBack crumb={t('campaigns.title')} title={c?.title || t('campaigns.title')} />
      <div className="scroll" data-testid="campaign-detail">
        {detail.loading && !d && <Loading />}
        {detail.error && !d && <Empty>{old ? t('campaigns.unsupported') : detail.error.message}</Empty>}
        {c && h && (
          <>
            <section className="frame cphead">
              <b data-testid="campaign-headline">{headlineText(h)}</b>
              {h.total > 0 && (
                <span className="cpbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${pct}%` }} />
                </span>
              )}
              <small className="muted">
                {t('campaigns.tasksDone', { done: h.done, total: h.total })}
                {c.tokenBudget
                  ? ` · ${t('campaigns.budget', { used: c.tokensUsed, budget: c.tokenBudget })}`
                  : c.tokensUsed > 0
                    ? ` · ${t('campaigns.tokens', { used: c.tokensUsed })}`
                    : ''}
              </small>
              <div className="cpbtns">
                {primary === 'pause' && (
                  <button type="button" className="btn pri" disabled={busy} onClick={() => run('pause', undefined, t('campaigns.paused'))}>
                    <I n="pause" size={13} /> {t('campaigns.pause')}
                  </button>
                )}
                {primary === 'resume' && (
                  <button type="button" className="btn pri" disabled={busy} onClick={() => run('resume', undefined, t('campaigns.resumed'))}>
                    <I n="play" size={13} /> {t('campaigns.resume')}
                  </button>
                )}
                {primary === 'coordinator' && (
                  <button type="button" className="btn" onClick={() => go({ name: 'cowork', id: c.coordinatorSession })}>
                    {t('campaigns.openCoordinator')}
                  </button>
                )}
                {!over && (
                  <button type="button" className="btn dan" disabled={busy} onClick={() => run('cancel', undefined, t('campaigns.cancelled'), t('campaigns.cancelConfirm'))}>
                    {t('campaigns.cancel')}
                  </button>
                )}
              </div>
            </section>
            {mine.length > 0 && (
              <section data-testid="campaign-approvals">
                <div className="gh">
                  <I n="shield" /> {t('campaigns.waitingForYou')}
                </div>
                {mine.map((a) => (
                  <ApprovalCard key={a.requestId} a={a} />
                ))}
              </section>
            )}
            {d && <ReviewPanel d={d} busy={busy} run={run} />}
            {TASK_GROUPS.map((g) => {
              const found = groups.find((x) => x.group === g)
              if (!found) return null
              return (
                <section key={g} data-testid={`campaign-group-${g}`}>
                  <div className="gh">
                    {t(`campaigns.group.${g}`)} <span className="cnt">{found.tasks.length}</span>
                  </div>
                  {found.tasks.map((m) => {
                    const task = c.tasks.find((x) => x.id === m.id)
                    return task ? <TaskRow key={task.id} task={task} all={c.tasks} run={run} /> : null
                  })}
                </section>
              )
            })}
          </>
        )}
      </div>
    </>
  )
}
