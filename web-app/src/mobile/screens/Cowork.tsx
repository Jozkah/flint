import type { CoworkDetail, RemoteMessage, SessionStatus } from '@/lib/remote/protocol'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { accessLabel, modeLabel } from '../shell/labels'
import { I } from '../ui/icons'
import { Empty, Loading } from '../ui/bits'
import { AssistantHeader, Notes, Prose, Reasoning, ToolTimeline, UserBubble } from '../ui/messages'
import { ApprovalCard } from '../ui/ApprovalCard'
import { AskCard } from '../ui/AskCard'
import { PromptCard } from '../ui/PromptCard'
import { ChangeBars, WhatChanged } from '../ui/changes'
import { PendingBubble, QueueBar, ResolvedLine, StreamingMessage } from '../ui/live'
import { client, openDrawer, openSheet, sendMessage, toast, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { pendingFor, prunePending, useLive } from '../state/live'
import { useFollow, useStickToBottom } from '../ui/hooks'
import { useEffect, useState } from 'react'
import { contextPct } from '../ui/format'
import { t } from '../i18n'

const STATUS: Record<SessionStatus, string> = {
  running: t('cowork.status.running'),
  waiting: t('cowork.status.waiting'),
  idle: t('cowork.status.idle'),
  paused: t('cowork.status.paused'),
  done: t('cowork.status.done'),
}

/** How the last run ended, in the words of the desktop's notices. */
const ENDING: Record<NonNullable<CoworkDetail['ending']>['by'], string> = {
  steps: t('cowork.ending.steps'),
  tokens: t('cowork.ending.tokens'),
  error: t('cowork.ending.error'),
  deadline: t('cowork.ending.deadline'),
  timeout: t('cowork.ending.timeout'),
  loop: t('cowork.ending.loop'),
  interrupted: t('cowork.ending.interrupted'),
}

export default function Cowork({ id }: { id: string }) {
  const detail = useRpc('cowork.get', { id })
  const msgs = useRpc('thread.messages', { id, kind: 'cowork', limit: 100 })
  const [older, setOlder] = useState<RemoteMessage[]>([])
  const [olderStart, setOlderStart] = useState<number | null>(null)
  const compacting = useApp((s) => Boolean(s.compacting[id]))
  const status = useRpc('status', {})
  const approvals = useRpc('approvals.list', {}, (status.data?.approvalsWaiting ?? 0) > 0)
  const asks = useRpc('asks.list', {}, (status.data?.questionsWaiting ?? 0) > 0)
  const promptList = useRpc('prompts.list', {}, (status.data?.promptsWaiting ?? 0) > 0)
  const changes = useRpc('cowork.changes', { id })
  const queue = useRpc('thread.queue', { id })
  const d = detail.data
  const messages = [...older, ...(msgs.data?.messages ?? []).filter((m) => !older.some((o) => o.id === m.id))]
  const earlier = olderStart ?? msgs.data?.start ?? 0
  const showEarlier = async () => {
    try {
      const page = await client().rpc('thread.messages', { id, kind: 'cowork', before: earlier, limit: 100 })
      setOlder((cur) => [...page.messages.filter((m) => !cur.some((c) => c.id === m.id)), ...cur])
      setOlderStart(page.start)
    } catch (e) {
      toast(e instanceof Error ? e.message : t('chat.loadEarlierFailed'))
    }
  }
  const mine = (approvals.data?.approvals ?? []).filter((a) => a.threadId === id)
  const questions = (asks.data?.asks ?? []).filter((a) => a.threadId === id)
  const prompts = (promptList.data?.prompts ?? []).filter((p) => p.threadId === id)
  const stream = useLive((s) => s.streams[id])
  const pending = pendingFor(
    useLive((s) => s.pending),
    id,
    messages
  )
  const resolvedAll = useLive((s) => s.resolved)
  const resolved = Object.entries(resolvedAll).filter(
    ([rid, r]) =>
      r.threadId === id &&
      !mine.some((a) => a.requestId === rid) &&
      !questions.some((a) => a.requestId === rid) &&
      !prompts.some((p) => p.id === rid)
  )
  useFollow('cowork', id)
  useEffect(() => {
    if (msgs.data) prunePending(id, msgs.data.messages)
  }, [id, msgs.data])
  const ref = useStickToBottom(messages.length + mine.length + questions.length + pending.length + (stream?.text.length ?? 0) + (stream?.tools.length ?? 0))
  const running = d?.status === 'running' || d?.status === 'waiting' || Boolean(stream && !stream.done)
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.id
  const todos = d?.todos ?? []
  const done = todos.filter((t) => t.status === 'completed').length
  const mode = modeLabel(d?.mode ?? 'ask')
  const access = accessLabel(d?.access ?? 'review-only')
  const stepCount = messages.reduce((n, m) => n + (m.tools?.length ?? 0), 0)
  const models = useRpc('models.list', {})
  const modelName = d?.model
    ? (models.data?.models.find((m) => m.id === d.model?.id && m.provider === d.model.provider)?.name ?? d.model.id)
    : t('chat.model')

  return (
    <>
      <TopThread
        crumb={
          <>
            {d && d.status !== 'idle' && d.status !== 'done' && (
              <span className={`sd ${d.status === 'waiting' ? 'wait' : 'run'}`} style={{ width: 6, height: 6 }} />
            )}
            {d ? (d.status === 'idle' ? t('cowork.crumb') : t('cowork.crumbStatus', { status: STATUS[d.status] })) : t('cowork.crumb')}
          </>
        }
        title={d?.title || t('cowork.untitled')}
        menu={() => openSheet('sessmenu', { id, title: d?.title })}
      />
      <div className="subbar">
        {d?.group && (
          <button type="button" className="chip" onClick={() => openSheet('workspace', { folder: d.folder, group: d.group })}>
            <I n="folder" size={13} />
            {d.group}
            <I n="chev" size={11} />
          </button>
        )}
        <button type="button" className="chip" onClick={() => openDrawer('right', 'timeline')}>
          <I n="activity" size={13} />
          {t('cowork.activity')} {stepCount > 0 ? stepCount : ''}
        </button>
        <button type="button" className="chip" onClick={() => openDrawer('right', 'changes')}>
          <I n="plus" size={12} />
          {t('cowork.changes')}
        </button>
      </div>
      <div className="scroll" ref={ref} data-testid="cowork-scroll">
        {(detail.loading || msgs.loading) && !msgs.data && <Loading />}
        {detail.error && !d && <Empty>{detail.error.message}</Empty>}
        {msgs.data && messages.length === 0 && pending.length === 0 && !stream && questions.length === 0 && (
          <Empty>{t('cowork.empty')}</Empty>
        )}
        {earlier > 0 && (
          <button type="button" className="btn ghost" style={{ alignSelf: 'center', margin: '4px 0 12px' }} onClick={() => void showEarlier()}>
            {t('cowork.showEarlier', { count: earlier })}
          </button>
        )}
        {messages.map((m) => {
          if (m.role === 'user') return <UserBubble key={m.id} text={m.text} attachments={m.attachments} />
          if (m.role !== 'assistant') return null
          const isLast = m.id === lastAssistant
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {(m.text || m.reasoning) && (
                <div className="msg">
                  <AssistantHeader model={d?.model?.id} at={m.createdAt} />
                  <Reasoning text={m.reasoning} />
                  {m.text && <Prose text={m.text} />}
                </div>
              )}
              {m.tools && m.tools.length > 0 && <ToolTimeline steps={m.tools} />}
              <Notes items={m.notes} />
              {isLast && mine.map((a) => <ApprovalCard key={a.requestId} a={a} />)}
            </div>
          )
        })}
        {!lastAssistant && mine.map((a) => <ApprovalCard key={a.requestId} a={a} />)}
        {pending.map((p) => (
          <PendingBubble key={p.clientId} p={p} />
        ))}
        {stream && <StreamingMessage s={stream} model={d?.model?.id} />}
        {/* After the reply in flight: the question is what the run stopped on. */}
        {questions.map((a) => (
          <AskCard key={a.requestId} a={a} />
        ))}
        {prompts.map((p) => (
          <PromptCard key={p.id} p={p} />
        ))}
        {resolved.map(([rid, r]) => (
          <ResolvedLine key={rid} r={r} />
        ))}
        {compacting && (
          <div className="compacting" role="status">
            <I n="loader" spin size={14} />
            {t('cowork.compacting')}
          </div>
        )}
        {d?.ending && !running && (
          <div className="endnote" role="status" data-testid="run-ending" data-ending={d.ending.by}>
            <span className="tx">
              <b>{ENDING[d.ending.by]}</b>
              {d.ending.message && <small>{d.ending.message}</small>}
            </span>
            <button
              type="button"
              className="btn sm pri"
              onClick={() => void sendMessage('cowork.send', { id, text: t('cowork.continueMessage'), resume: true })}
            >
              {d.ending.by === 'steps' || d.ending.by === 'tokens' || d.ending.by === 'interrupted' ? t('cowork.keepGoing') : t('cowork.tryAgain')}
            </button>
          </div>
        )}
        {changes.data && !running && <WhatChanged c={changes.data} />}
        {changes.data && <ChangeBars c={changes.data} />}
      </div>
      {todos.length > 0 && (
        <div className="plan" role="button" data-tool-kind="todo" onClick={() => openDrawer('right', 'progress')}>
          <I n="todo" size={14} style={{ color: 'var(--tk)' }} />
          <span>{t('cowork.progress')}</span>
          <span className="pb">
            <i style={{ width: `${(done / todos.length) * 100}%` }} />
          </span>
          <span className="muted">
            {t('cowork.progressCount', { done, total: todos.length })}
          </span>
        </div>
      )}
      <QueueBar items={queue.data?.items ?? []} />
      <Composer
        placeholder={t('chat.placeholder')}
        plus={{ for: 'cowork', id }}
        ctx={{ pct: contextPct(detail.data?.context), for: 'cowork', id }}
        running={running}
        stopFor={{ kind: 'cowork', id }}
        allowWhileRunning
        onSend={async (text) => (await sendMessage('cowork.send', { id, text })) !== undefined}
        onSteer={async (text) => (await sendMessage('cowork.send', { id, text, steer: true })) !== undefined}
      />
      <div className="runrow">
        <button type="button" className={`rq${d?.mode === 'auto' ? ' amber' : ''}`} onClick={() => openSheet('mode', { id, value: d?.mode })}>
          <span>{mode?.short}</span>
        </button>
        <button type="button" className={`rq${d?.access === 'edit-folder' ? ' amber' : ''}`} onClick={() => openSheet('access', { id, value: d?.access })}>
          <span>{access?.short}</span>
        </button>
        <button type="button" className="rq" onClick={() => openSheet('profile', { id })}>
          <I n="wand" size={13} />
          {t('chat.auto')}
        </button>
        <button type="button" className="rq rm2" onClick={() => openSheet('model', { for: 'cowork', id })}>
          <span>{modelName}</span>
        </button>
      </div>
    </>
  )
}
